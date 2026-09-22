import express from 'express';
import basicAuth from 'basic-auth';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 8420;

// Host filesystem mount point (when running in container with -v /:/hostfs)
const HOST_ROOT = process.env.HOST_ROOT && process.env.HOST_ROOT !== '/' 
  ? process.env.HOST_ROOT 
  : '';

const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'dibberlab';

// Basic Auth Middleware
const authMiddleware = (req, res, next) => {
  // Allow healthcheck without auth
  if (req.path === '/healthz' || req.path === '/_health') {
    return next();
  }
  const credentials = basicAuth(req);
  if (!credentials || credentials.name !== AUTH_USER || credentials.pass !== AUTH_PASS) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Storage Explorer"');
    return res.status(401).send('Access denied: Authentication required');
  }
  next();
};

app.use(authMiddleware);
app.use(express.json());
app.use(express.static('public'));

// Resolve user virtual path to host physical path
function toHostPath(userPath) {
  const normalized = path.normalize(userPath);
  if (HOST_ROOT) {
    return path.join(HOST_ROOT, normalized);
  }
  return normalized;
}

// Convert host physical path back to display path
function toDisplayPath(hostPath) {
  if (HOST_ROOT && hostPath.startsWith(HOST_ROOT)) {
    const stripped = hostPath.slice(HOST_ROOT.length);
    return stripped.startsWith('/') ? stripped : '/' + stripped;
  }
  return hostPath;
}

// Format bytes helper
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// GET /api/overview
app.get('/api/overview', async (req, res) => {
  try {
    const target = HOST_ROOT || '/';
    const { stdout } = await execAsync(`df -k "${target}" | tail -n 1`);
    const parts = stdout.trim().split(/\s+/);
    // Filesystem 1K-blocks Used Available Use% Mounted
    const totalBytes = parseInt(parts[1], 10) * 1024;
    const usedBytes = parseInt(parts[2], 10) * 1024;
    const freeBytes = parseInt(parts[3], 10) * 1024;
    const usedPercent = parts[4];

    res.json({
      totalBytes,
      usedBytes,
      freeBytes,
      totalFormatted: formatBytes(totalBytes),
      usedFormatted: formatBytes(usedBytes),
      freeFormatted: formatBytes(freeBytes),
      usedPercent
    });
  } catch (err) {
    console.error('Error getting disk overview:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scan?path=/var/www
app.get('/api/scan', async (req, res) => {
  try {
    let targetPath = req.query.path || '/var/www';
    if (!targetPath.startsWith('/')) targetPath = '/' + targetPath;

    const hostPath = toHostPath(targetPath);

    // Verify directory exists
    const stat = await fs.stat(hostPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Target path is not a directory' });
    }

    // Run du -sk to rapidly calculate child sizes
    // du -sk "${hostPath}"/* "${hostPath}"/.[!.]* 2>/dev/null
    let duOutput = '';
    try {
      const { stdout } = await execAsync(
        `du -sk "${hostPath}"/* "${hostPath}"/.[!.]* 2>/dev/null || true`,
        { maxBuffer: 10 * 1024 * 1024 }
      );
      duOutput = stdout;
    } catch {
      duOutput = '';
    }

    const items = [];
    let totalSize = 0;

    // Parse du output
    const sizeMap = new Map();
    const lines = duOutput.trim().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (match) {
        const kb = parseInt(match[1], 10);
        const p = match[2];
        sizeMap.set(p, kb * 1024);
      }
    }

    // Read dir entries
    const entries = await fs.readdir(hostPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryHostPath = path.join(hostPath, entry.name);
      const isDir = entry.isDirectory();
      let size = sizeMap.get(entryHostPath) || 0;

      // If not in du map, stat it
      if (size === 0) {
        try {
          const s = await fs.stat(entryHostPath);
          size = s.size;
        } catch {
          size = 0;
        }
      }

      totalSize += size;
      const ext = isDir ? 'folder' : (path.extname(entry.name).toLowerCase().replace('.', '') || 'file');

      items.push({
        name: entry.name,
        path: path.join(targetPath, entry.name),
        isDir,
        size,
        sizeFormatted: formatBytes(size),
        extension: ext
      });
    }

    // Sort descending by size
    items.sort((a, b) => b.size - a.size);

    // Calculate percentage of parent
    for (const item of items) {
      item.percentage = totalSize > 0 ? ((item.size / totalSize) * 100).toFixed(1) : 0;
    }

    res.json({
      currentPath: targetPath,
      parentPath: targetPath === '/' ? null : path.dirname(targetPath),
      totalSize,
      totalSizeFormatted: formatBytes(totalSize),
      itemCount: items.length,
      items
    });
  } catch (err) {
    console.error('Error scanning path:', err);
    res.status(500).json({ error: err.message });
  }
});

// Forbidden paths blacklist for delete operations
const FORBIDDEN_PATHS = new Set([
  '/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', 
  '/lost+found', '/proc', '/root', '/run', '/sbin', '/sys', 
  '/usr', '/var', '/var/lib', '/var/log', '/var/www',
  '/hostfs', '/hostfs/', '/hostfs/bin', '/hostfs/boot', '/hostfs/etc',
  '/hostfs/lib', '/hostfs/root', '/hostfs/usr', '/hostfs/var'
]);

// POST /api/delete
app.post('/api/delete', async (req, res) => {
  try {
    const { path: reqPath } = req.body;
    if (!reqPath || typeof reqPath !== 'string') {
      return res.status(400).json({ error: 'Path is required' });
    }

    const normalized = path.normalize(reqPath);
    if (FORBIDDEN_PATHS.has(normalized)) {
      return res.status(403).json({ error: `Cannot delete protected system directory: ${normalized}` });
    }

    // Must have at least 2 levels (e.g. /var/www/test or /tmp/junk)
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length < 2) {
      return res.status(403).json({ error: `Refusing to delete top-level path: ${normalized}` });
    }

    const hostPath = toHostPath(normalized);

    // Stat before deleting
    const stat = await fs.stat(hostPath);
    if (stat.isDirectory()) {
      await fs.rm(hostPath, { recursive: true, force: true });
    } else {
      await fs.unlink(hostPath);
    }

    res.json({ success: true, deletedPath: normalized });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prune
app.post('/api/prune', async (req, res) => {
  try {
    const { action } = req.body;
    let cmd = '';

    if (action === 'docker') {
      cmd = 'docker builder prune -f && docker image prune -f';
    } else if (action === 'journal') {
      cmd = 'journalctl --vacuum-size=200M';
    } else if (action === 'npm') {
      cmd = 'rm -rf /root/.npm';
    } else {
      return res.status(400).json({ error: 'Invalid prune action' });
    }

    const { stdout, stderr } = await execAsync(cmd);
    res.json({ success: true, output: stdout || stderr });
  } catch (err) {
    console.error('Prune error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health endpoint
app.get('/healthz', (req, res) => {
  res.send('OK');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Storage Explorer listening on port ${PORT}`);
});
