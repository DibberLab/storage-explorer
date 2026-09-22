// Storage Explorer Frontend Application

let currentPath = '/var/www';
let currentData = null;
let treemapRects = [];
let hoveredRect = null;
let itemToDelete = null;

const canvas = document.getElementById('treemapCanvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('canvasTooltip');
const loadingOverlay = document.getElementById('loadingOverlay');

// Color categories
function getItemColor(item) {
  if (item.isDir) {
    if (item.name === 'node_modules') return '#059669'; // Emerald
    if (item.name.includes('docker') || item.name.includes('overlay2')) return '#7c3aed'; // Purple
    if (item.name.includes('log') || item.name.includes('journal')) return '#dc2626'; // Red
    return '#475569'; // Slate for general folders
  }
  const ext = item.extension.toLowerCase();
  // Archives
  if (['tar', 'gz', 'zip', 'wpress', 'bz2', 'xz', '7z', 'rar', 'tgz'].includes(ext)) {
    return '#2563eb'; // Blue
  }
  // Databases & Volumes
  if (['sqlite', 'db', 'sql', 'rdb', 'wal', 'data'].includes(ext)) {
    return '#9333ea'; // Purple
  }
  // Web & Code
  if (['js', 'ts', 'jsx', 'tsx', 'php', 'py', 'html', 'css', 'json', 'yml', 'yaml', 'md'].includes(ext)) {
    return '#10b981'; // Emerald
  }
  // Media
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp4', 'mkv', 'mov', 'mp3', 'wav', 'flac'].includes(ext)) {
    return '#d97706'; // Amber
  }
  // Logs & Temp
  if (['log', 'journal', 'tmp', 'cache', 'bak', 'old'].includes(ext)) {
    return '#e11d48'; // Rose
  }
  return '#64748b'; // Slate
}

// Squarified Treemap Algorithm
function computeSquarifiedTreemap(items, x, y, width, height) {
  const rects = [];
  const validItems = items.filter(i => i.size > 0);
  const total = validItems.reduce((acc, i) => acc + i.size, 0);
  if (total === 0 || width <= 0 || height <= 0) return rects;

  function squarify(children, row, w, rect) {
    if (children.length === 0) {
      layoutRow(row, w, rect);
      return;
    }

    const c = children[0];
    const newRow = [...row, c];

    if (row.length === 0 || worst(row, w) >= worst(newRow, w)) {
      squarify(children.slice(1), newRow, w, rect);
    } else {
      const remainingRect = layoutRow(row, w, rect);
      const newW = Math.min(remainingRect.width, remainingRect.height);
      squarify(children, [], newW, remainingRect);
    }
  }

  function worst(row, w) {
    const s = row.reduce((acc, item) => acc + item.scaledSize, 0);
    if (s === 0 || w === 0) return Infinity;
    let max = 0;
    for (const item of row) {
      const r = item.scaledSize;
      const ratio = Math.max((w * w * r) / (s * s), (s * s) / (w * w * r));
      if (ratio > max) max = ratio;
    }
    return max;
  }

  function layoutRow(row, w, rect) {
    const rowArea = row.reduce((acc, item) => acc + item.scaledSize, 0);
    const isHorizontal = rect.width >= rect.height;

    if (isHorizontal) {
      const rowWidth = rect.height > 0 ? rowArea / rect.height : 0;
      let currentY = rect.y;
      for (const item of row) {
        const itemHeight = rowWidth > 0 ? item.scaledSize / rowWidth : 0;
        rects.push({
          x: rect.x,
          y: currentY,
          width: rowWidth,
          height: itemHeight,
          item: item.original
        });
        currentY += itemHeight;
      }
      return {
        x: rect.x + rowWidth,
        y: rect.y,
        width: Math.max(0, rect.width - rowWidth),
        height: rect.height
      };
    } else {
      const rowHeight = rect.width > 0 ? rowArea / rect.width : 0;
      let currentX = rect.x;
      for (const item of row) {
        const itemWidth = rowHeight > 0 ? item.scaledSize / rowHeight : 0;
        rects.push({
          x: currentX,
          y: rect.y,
          width: itemWidth,
          height: rowHeight,
          item: item.original
        });
        currentX += itemWidth;
      }
      return {
        x: rect.x,
        y: rect.y + rowHeight,
        width: rect.width,
        height: Math.max(0, rect.height - rowHeight)
      };
    }
  }

  const area = width * height;
  const scaledChildren = validItems.map(item => ({
    scaledSize: (item.size / total) * area,
    original: item
  }));

  const initialW = Math.min(width, height);
  squarify(scaledChildren, [], initialW, { x, y, width, height });
  return rects;
}

// Render Treemap to Canvas
function drawTreemap() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!currentData || !currentData.items) return;

  treemapRects = computeSquarifiedTreemap(currentData.items, 0, 0, rect.width, rect.height);

  for (const r of treemapRects) {
    const isHovered = hoveredRect && hoveredRect.item.path === r.item.path;
    ctx.fillStyle = getItemColor(r.item);

    // Draw rectangle
    ctx.beginPath();
    ctx.rect(r.x + 0.5, r.y + 0.5, Math.max(0, r.width - 1), Math.max(0, r.height - 1));
    ctx.fill();

    // Border
    ctx.lineWidth = isHovered ? 2 : 1;
    ctx.strokeStyle = isHovered ? '#ffffff' : '#0f172a';
    ctx.stroke();

    // Label if space allows
    if (r.width > 60 && r.height > 24) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '11px monospace';
      const text = r.item.name;
      const metrics = ctx.measureText(text);
      if (metrics.width < r.width - 12) {
        ctx.fillText(text, r.x + 6, r.y + 16);
        if (r.height > 40) {
          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          ctx.font = '10px monospace';
          ctx.fillText(r.item.sizeFormatted, r.x + 6, r.y + 30);
        }
      }
    }
  }
}

// Fetch System Overview
async function fetchOverview() {
  try {
    const res = await fetch('/api/overview');
    const data = await res.json();
    document.getElementById('diskGaugeText').textContent = `${data.usedFormatted} / ${data.totalFormatted} (${data.usedPercent})`;
    document.getElementById('diskGaugeBar').style.width = data.usedPercent;
  } catch (err) {
    console.error('Failed to load disk overview:', err);
  }
}

// Fetch Directory Scan
async function fetchScan(path) {
  loadingOverlay.classList.remove('hidden');
  try {
    const res = await fetch(`/api/scan?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      const err = await res.json();
      alert(`Error: ${err.error}`);
      return;
    }
    currentData = await res.json();
    currentPath = currentData.currentPath;
    renderBreadcrumbs();
    renderTable(currentData.items);
    drawTreemap();
    updateScopeButtons();
  } catch (err) {
    alert(`Failed to scan: ${err.message}`);
  } finally {
    loadingOverlay.classList.add('hidden');
  }
}

// Breadcrumb Navigation
function renderBreadcrumbs() {
  const container = document.getElementById('breadcrumbs');
  container.innerHTML = '';

  const parts = currentPath.split('/').filter(Boolean);
  let accumulated = '';

  // Root crumb
  const rootSpan = document.createElement('span');
  rootSpan.className = 'hover:text-blue-400 cursor-pointer font-bold';
  rootSpan.textContent = '/';
  rootSpan.onclick = () => navigateTo('/');
  container.appendChild(rootSpan);

  for (let i = 0; i < parts.length; i++) {
    accumulated += '/' + parts[i];
    const target = accumulated;

    const sep = document.createElement('span');
    sep.className = 'text-slate-600';
    sep.textContent = '/';
    container.appendChild(sep);

    const crumb = document.createElement('span');
    crumb.className = i === parts.length - 1 
      ? 'text-white font-bold' 
      : 'hover:text-blue-400 cursor-pointer';
    crumb.textContent = parts[i];
    crumb.onclick = () => navigateTo(target);
    container.appendChild(crumb);
  }

  // Stats
  document.getElementById('folderStats').textContent = 
    `${currentData.totalSizeFormatted} • ${currentData.itemCount} items`;

  // Up button state
  document.getElementById('upBtn').disabled = currentPath === '/';
}

// Render Table
function renderTable(items) {
  const tbody = document.getElementById('fileTableBody');
  tbody.innerHTML = '';

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="py-8 text-center text-slate-500">Directory is empty</td></tr>`;
    return;
  }

  for (const item of items) {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/50 transition group';

    const iconColor = getItemColor(item);

    tr.innerHTML = `
      <td class="py-2.5 px-4 flex items-center gap-2.5 truncate max-w-md">
        <span class="w-3 h-3 rounded-sm flex-shrink-0" style="background-color: ${iconColor}"></span>
        ${item.isDir ? `
          <button onclick="navigateTo('${item.path}')" class="font-medium text-blue-400 hover:underline flex items-center gap-1.5 truncate">
            📁 ${item.name}
          </button>
        ` : `
          <span class="text-slate-200 truncate">📄 ${item.name}</span>
        `}
      </td>
      <td class="py-2.5 px-4 font-mono text-slate-300">${item.sizeFormatted}</td>
      <td class="py-2.5 px-4">
        <div class="flex items-center gap-2">
          <div class="flex-1 bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div class="bg-blue-500 h-1.5 rounded-full" style="width: ${item.percentage}%"></div>
          </div>
          <span class="text-slate-400 w-12 text-right">${item.percentage}%</span>
        </div>
      </td>
      <td class="py-2.5 px-4 text-right">
        <button onclick="promptDelete('${item.path}')" class="opacity-0 group-hover:opacity-100 px-2 py-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded text-[11px] border border-rose-500/20 transition">
          Delete
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

// Filter items
function filterItems() {
  const q = document.getElementById('filterInput').value.toLowerCase();
  if (!currentData || !currentData.items) return;
  const filtered = currentData.items.filter(i => i.name.toLowerCase().includes(q));
  renderTable(filtered);
}

// Navigation helpers
function navigateTo(path) {
  document.getElementById('filterInput').value = '';
  fetchScan(path);
}

function navigateUp() {
  if (currentData && currentData.parentPath) {
    navigateTo(currentData.parentPath);
  }
}

function refreshCurrent() {
  fetchOverview();
  fetchScan(currentPath);
}

function updateScopeButtons() {
  const btns = document.querySelectorAll('.scope-btn');
  btns.forEach(btn => {
    if (btn.getAttribute('data-path') === currentPath) {
      btn.className = 'scope-btn px-2.5 py-1 rounded bg-blue-600 text-white font-medium';
    } else {
      btn.className = 'scope-btn px-2.5 py-1 rounded hover:bg-slate-700 transition text-slate-300';
    }
  });
}

// Canvas Mouse Interactions
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  let found = null;
  for (const r of treemapRects) {
    if (mouseX >= r.x && mouseX <= r.x + r.width && mouseY >= r.y && mouseY <= r.y + r.height) {
      found = r;
      break;
    }
  }

  if (found !== hoveredRect) {
    hoveredRect = found;
    drawTreemap();

    if (found) {
      tooltip.style.left = `${Math.min(mouseX + 15, rect.width - 200)}px`;
      tooltip.style.top = `${Math.min(mouseY + 15, rect.height - 80)}px`;
      tooltip.innerHTML = `
        <div class="font-bold font-mono">${found.item.name}</div>
        <div class="text-slate-400 text-[11px]">${found.item.path}</div>
        <div class="mt-1 flex items-center justify-between gap-4 font-mono text-blue-400">
          <span>${found.item.sizeFormatted}</span>
          <span>${found.item.percentage}%</span>
        </div>
      `;
      tooltip.classList.remove('hidden');
    } else {
      tooltip.classList.add('hidden');
    }
  }
});

canvas.addEventListener('mouseleave', () => {
  hoveredRect = null;
  tooltip.classList.add('hidden');
  drawTreemap();
});

canvas.addEventListener('click', () => {
  if (hoveredRect && hoveredRect.item.isDir) {
    navigateTo(hoveredRect.item.path);
  }
});

// Delete Modal Handling
function promptDelete(path) {
  itemToDelete = path;
  document.getElementById('deleteTargetText').textContent = path;
  document.getElementById('deleteModal').classList.remove('hidden');
  document.getElementById('deleteModal').classList.add('flex');
}

function closeDeleteModal() {
  itemToDelete = null;
  document.getElementById('deleteModal').classList.add('hidden');
  document.getElementById('deleteModal').classList.remove('flex');
}

document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
  if (!itemToDelete) return;
  try {
    const res = await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: itemToDelete })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`Delete failed: ${data.error}`);
    } else {
      closeDeleteModal();
      refreshCurrent();
    }
  } catch (err) {
    alert(`Error deleting item: ${err.message}`);
  }
});

// Prune Modal Handling
function openPruneModal() {
  document.getElementById('pruneOutput').classList.add('hidden');
  document.getElementById('pruneModal').classList.remove('hidden');
  document.getElementById('pruneModal').classList.add('flex');
}

function closePruneModal() {
  document.getElementById('pruneModal').classList.add('hidden');
  document.getElementById('pruneModal').classList.remove('flex');
}

async function executePrune(action) {
  const out = document.getElementById('pruneOutput');
  out.textContent = 'Executing prune action...';
  out.classList.remove('hidden');
  try {
    const res = await fetch('/api/prune', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    const data = await res.json();
    if (!res.ok) {
      out.textContent = `Failed: ${data.error}`;
    } else {
      out.textContent = data.output || 'Cleaned successfully.';
      fetchOverview();
      refreshCurrent();
    }
  } catch (err) {
    out.textContent = `Error: ${err.message}`;
  }
}

// Window resize
window.addEventListener('resize', () => {
  drawTreemap();
});

// Initialize
fetchOverview();
fetchScan('/var/www');
