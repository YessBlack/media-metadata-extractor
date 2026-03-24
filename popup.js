// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        
        // Remove active class from all tabs and buttons
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        
        // Add active class to clicked button and corresponding tab
        btn.classList.add('active');
        document.getElementById(tab).classList.add('active');
    });
});

let isYTExtracting = false;
let isYTPaused = false;
const ytStateStaleMs = 180000;
let activeTabId = null;
let activeYouTubeVideoId = '';

function getYouTubeVideoIdFromUrl(url) {
    if (!url) {
        return '';
    }

    try {
        const parsed = new URL(url);
        if (!parsed.hostname.includes('youtube.com')) {
            return '';
        }
        return parsed.searchParams.get('v') || '';
    } catch (error) {
        return '';
    }
}

async function refreshActiveTabContext() {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    activeTabId = tab?.id || null;
    activeYouTubeVideoId = getYouTubeVideoIdFromUrl(tab?.url || '');
    return tab;
}

function storageGet(keys) {
    return new Promise((resolve, reject) => {
        try {
            chrome.storage.local.get(keys, (result) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve(result || {});
            });
        } catch (error) {
            reject(error);
        }
    });
}

function storageSet(value) {
    return new Promise((resolve, reject) => {
        try {
            chrome.storage.local.set(value, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve();
            });
        } catch (error) {
            reject(error);
        }
    });
}

function storageRemove(keys) {
    return new Promise((resolve, reject) => {
        try {
            chrome.storage.local.remove(keys, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve();
            });
        } catch (error) {
            reject(error);
        }
    });
}

// Restore YouTube extraction state when popup opens
async function restoreYTExtractionState() {
    try {
        const tab = await refreshActiveTabContext();
        if (!tab?.url?.includes('youtube.com')) {
            return;
        }

        const data = await storageGet('ytExtractionStates');
        const states = data?.ytExtractionStates && typeof data.ytExtractionStates === 'object'
            ? data.ytExtractionStates
            : {};

        const state = activeYouTubeVideoId ? states[activeYouTubeVideoId] : null;

        if (state) {

            if (Date.now() - Number(state.timestamp || 0) > ytStateStaleMs) {
                delete states[activeYouTubeVideoId];
                await storageSet({ ytExtractionStates: states });
                return;
            }

            const status = document.getElementById('ytStatus');
            const extractBtn = document.getElementById('extractYTComments');
            const pauseBtn = document.getElementById('toggleYTPause');
            const stopBtn = document.getElementById('stopYT');

            const activePhase = state.phase === 'running' || state.phase === 'paused';
            const isActiveRun = !!state.running && activePhase;

            const renderFinalStatus = () => {
                const collected = Number(state.collected || 0);
                const expected = Number(state.expected || 0);
                extractBtn.disabled = false;
                pauseBtn.disabled = true;
                stopBtn.disabled = true;
                pauseBtn.textContent = 'Pausar';
                isYTExtracting = false;
                isYTPaused = false;

                if (state.phase === 'limit') {
                    status.className = 'status success';
                    status.textContent = expected > 0
                        ? `ℹ️ Límite alcanzado (${collected}/${expected})`
                        : `ℹ️ Límite alcanzado (${collected})`;
                } else if (state.phase === 'complete') {
                    const mismatch = expected > 0 && collected < expected;
                    status.className = 'status success';
                    status.textContent = mismatch
                        ? `✅ ${collected} comentarios extraídos (YouTube mostraba ${expected})`
                        : `✅ ${collected} comentarios extraídos`;
                } else if (state.phase === 'stopped') {
                    status.className = 'status success';
                    status.textContent = `🛑 Proceso detenido (${collected})`;
                } else {
                    status.className = 'status';
                    status.textContent = '';
                }
            };

            if (!isActiveRun) {
                renderFinalStatus();
                return;
            }

            isYTExtracting = true;
            
            // Enable pause button, disable extract button
            extractBtn.disabled = true;
            pauseBtn.disabled = false;
            stopBtn.disabled = false;
            
            // Restore UI state based on stored state
            if (state.phase === 'paused') {
                isYTPaused = true;
                pauseBtn.textContent = 'Reanudar';
                status.className = 'status loading';
                status.textContent = state.expected > 0
                    ? `⏸️ Pausado ${state.collected}/${state.expected}`
                    : `⏸️ Pausado ${state.collected}`;
            } else {
                isYTPaused = false;
                status.className = 'status loading';
                status.textContent = state.expected > 0
                    ? `⏳ Extrayendo... ${state.collected}/${state.expected}`
                    : `⏳ Extrayendo... ${state.collected}`;
                pauseBtn.textContent = 'Pausar';
            }
            
            // Try to resume monitoring from content script if possible
            try {
                const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
                if (tab?.id && tab.url.includes('youtube.com')) {
                    chrome.tabs.sendMessage(tab.id, {
                        action: 'resumeMonitoring'
                    }, async (response) => {
                        const hasRuntimeError = !!chrome.runtime.lastError;
                        if (hasRuntimeError || !response?.success) {
                            const latest = await storageGet('ytExtractionStates');
                            const latestStates = latest?.ytExtractionStates && typeof latest.ytExtractionStates === 'object'
                                ? { ...latest.ytExtractionStates }
                                : {};

                            if (activeYouTubeVideoId && latestStates[activeYouTubeVideoId]) {
                                delete latestStates[activeYouTubeVideoId];
                                await storageSet({ ytExtractionStates: latestStates });
                            }

                            isYTExtracting = false;
                            isYTPaused = false;
                            extractBtn.disabled = false;
                            pauseBtn.disabled = true;
                            stopBtn.disabled = true;
                            pauseBtn.textContent = 'Pausar';
                            status.className = 'status';
                            status.textContent = '';
                        }
                    });
                }
            } catch (error) {
                // Ignore errors
            }
        }
    } catch (error) {
        console.warn('Failed to restore YT extraction state:', error);
    }
}

// Restore state when popup opens
document.addEventListener('DOMContentLoaded', restoreYTExtractionState);

chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.action !== 'ytExtractionProgress') {
        return;
    }

    const senderTabId = sender?.tab?.id;
    if (activeTabId && senderTabId && senderTabId !== activeTabId) {
        return;
    }

    const status = document.getElementById('ytStatus');
    const payload = message.payload || {};
    const payloadVideoId = payload.videoId || '';
    if (activeYouTubeVideoId && payloadVideoId && payloadVideoId !== activeYouTubeVideoId) {
        return;
    }

    const collected = Number(payload.collected || 0);
    const expected = Number(payload.expected || 0);
    const phase = payload.phase || 'running';
    const extractBtn = document.getElementById('extractYTComments');
    const pauseBtn = document.getElementById('toggleYTPause');
    const stopBtn = document.getElementById('stopYT');

    const phaseIsActive = phase === 'running' || phase === 'paused';
    isYTExtracting = phaseIsActive;
    isYTPaused = phase === 'paused';
    extractBtn.disabled = phaseIsActive;
    pauseBtn.disabled = !phaseIsActive;
    stopBtn.disabled = !phaseIsActive;
    pauseBtn.textContent = isYTPaused ? 'Reanudar' : 'Pausar';

    if (phase === 'running') {
        status.className = 'status loading';
        status.textContent = expected > 0
            ? `⏳ Extrayendo... ${collected}/${expected}`
            : `⏳ Extrayendo... ${collected}`;
    } else if (phase === 'paused') {
        status.className = 'status loading';
        status.textContent = expected > 0
            ? `⏸️ Pausado ${collected}/${expected}`
            : `⏸️ Pausado ${collected}`;
    } else if (phase === 'limit') {
        status.className = 'status success';
        status.textContent = expected > 0
            ? `ℹ️ Límite alcanzado (${collected}/${expected})`
            : `ℹ️ Límite alcanzado (${collected})`;
    } else if (phase === 'stopped') {
        status.className = 'status success';
        status.textContent = `🛑 Proceso detenido (${collected})`;
    } else if (phase === 'complete') {
        const mismatch = expected > 0 && collected < expected;
        status.className = 'status success';
        status.textContent = mismatch
            ? `✅ ${collected} comentarios extraídos (YouTube mostraba ${expected})`
            : `✅ ${collected} comentarios extraídos`;
    }
});

// YouTube Comments Extraction
document.getElementById('extractYTComments').addEventListener('click', async () => {
    const extractBtn = document.getElementById('extractYTComments');
    const status = document.getElementById('ytStatus');
    const preview = document.getElementById('ytPreview');
    const downloadBtn = document.getElementById('downloadYT');
    const copyBtn = document.getElementById('copyYT');
    const pauseBtn = document.getElementById('toggleYTPause');
    const stopBtn = document.getElementById('stopYT');
    const limitInput = document.getElementById('ytLimit');
    const batchSizeInput = document.getElementById('ytBatchSize');

    const limit = Math.max(Number.parseInt(limitInput.value || '0', 10) || 0, 0);
    const batchSize = Math.max(Number.parseInt(batchSizeInput.value || '50', 10) || 50, 10);
    
    isYTExtracting = true;
    isYTPaused = false;
    extractBtn.disabled = true;
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
    pauseBtn.textContent = 'Pausar';

    status.className = 'status loading';
    status.textContent = '⏳ Extrayendo comentarios...';
    preview.innerHTML = '';
    downloadBtn.disabled = true;
    copyBtn.disabled = true;
    
    try {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
        
        // Check if we're on YouTube
        if (!tab.url.includes('youtube.com')) {
            throw new Error('Por favor, abre una página de YouTube primero');
        }

        let comments = null;

        try {
            const response = await chrome.tabs.sendMessage(tab.id, {
                action: 'extractYTComments',
                options: { limit, batchSize }
            });

            if (response && response.success) {
                comments = response.data;
            } else if (response) {
                throw new Error(response.error || 'Error desconocido');
            }
        } catch (msgError) {
            // Chrome's message channel may have timed out (~5 min) while the content
            // script was still working. Try to recover from storage snapshots saved
            // during extraction.
            const stored = await new Promise(resolve =>
                chrome.storage.local.get('ytComments', result => resolve(result))
            );
            if (stored.ytComments && stored.ytComments.length > 0) {
                comments = stored.ytComments;
            } else {
                throw msgError;
            }
        }

        if (comments && comments.length > 0) {
            status.className = 'status success';
            status.textContent = `✅ ${comments.length} comentarios extraídos`;

            chrome.storage.local.set({ ytComments: comments });
            downloadBtn.disabled = false;
            copyBtn.disabled = false;

            showPreview(preview, comments.slice(0, 5), 'youtube');
        } else {
            throw new Error('No se pudieron extraer comentarios. Intenta de nuevo.');
        }
    } catch (error) {
        status.className = 'status error';
        status.textContent = `❌ Error: ${error.message}`;
    } finally {
        isYTExtracting = false;
        isYTPaused = false;
        extractBtn.disabled = false;
        pauseBtn.disabled = true;
        stopBtn.disabled = true;
        pauseBtn.textContent = 'Pausar';
    }
});

document.getElementById('toggleYTPause').addEventListener('click', async () => {
    if (!isYTExtracting) {
        return;
    }

    const status = document.getElementById('ytStatus');
    const pauseBtn = document.getElementById('toggleYTPause');

    try {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
        if (!tab?.id || !tab.url.includes('youtube.com')) {
            throw new Error('Abre YouTube para pausar/reanudar');
        }

        isYTPaused = !isYTPaused;
        pauseBtn.textContent = isYTPaused ? 'Reanudar' : 'Pausar';

        await chrome.tabs.sendMessage(tab.id, {
            action: 'setYTPause',
            paused: isYTPaused
        });
        
        // Update state in storage with pause status
        const data = await storageGet('ytExtractionStates');
        const states = data?.ytExtractionStates && typeof data.ytExtractionStates === 'object'
            ? { ...data.ytExtractionStates }
            : {};
        if (activeYouTubeVideoId && states[activeYouTubeVideoId]) {
            states[activeYouTubeVideoId].phase = isYTPaused ? 'paused' : 'running';
            states[activeYouTubeVideoId].timestamp = Date.now();
            await storageSet({ ytExtractionStates: states });
        }

        status.className = 'status loading';
        status.textContent = isYTPaused ? '⏸️ Extracción pausada' : '⏳ Extracción reanudada';
    } catch (error) {
        status.className = 'status error';
        status.textContent = `❌ ${error.message}`;
    }
});

document.getElementById('stopYT').addEventListener('click', async () => {
    if (!isYTExtracting) {
        return;
    }

    const status = document.getElementById('ytStatus');
    const extractBtn = document.getElementById('extractYTComments');
    const pauseBtn = document.getElementById('toggleYTPause');
    const stopBtn = document.getElementById('stopYT');

    try {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
        if (!tab?.id || !tab.url.includes('youtube.com')) {
            throw new Error('Abre YouTube para detener el proceso');
        }

        await chrome.tabs.sendMessage(tab.id, {
            action: 'setYTStop'
        });

        isYTExtracting = false;
        isYTPaused = false;
        extractBtn.disabled = false;
        pauseBtn.disabled = true;
        stopBtn.disabled = true;
        pauseBtn.textContent = 'Pausar';

        status.className = 'status success';
        status.textContent = '🛑 Proceso detenido';
    } catch (error) {
        status.className = 'status error';
        status.textContent = `❌ ${error.message}`;
    }
});

// Spotify Extraction
document.getElementById('extractSpotify').addEventListener('click', async () => {
    const status = document.getElementById('spotifyStatus');
    const preview = document.getElementById('spotifyPreview');
    const downloadBtn = document.getElementById('downloadSpotify');
    const copyBtn = document.getElementById('copySpotify');
    
    status.className = 'status loading';
    status.textContent = '⏳ Extrayendo canciones... desplázate por la lista mientras carga';
    preview.innerHTML = '';
    downloadBtn.disabled = true;
    copyBtn.disabled = true;
    
    try {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
        
        // Check if we're on Spotify
        if (!tab.url.includes('spotify.com')) {
            throw new Error('Por favor, abre Spotify primero');
        }
        
        const response = await chrome.tabs.sendMessage(tab.id, {
            action: 'extractSpotify'
        });
        
        if (response.success) {
            const tracks = response.data;
            
            status.className = 'status success';
            status.textContent = `✅ ${tracks.length} canciones extraídas`;
            
            // Store data for download
            chrome.storage.local.set({spotifyTracks: tracks});
            downloadBtn.disabled = false;
            copyBtn.disabled = false;
            
            // Show preview
            showPreview(preview, tracks.slice(0, 5), 'spotify');
        } else {
            throw new Error(response.error || 'Error desconocido');
        }
    } catch (error) {
        status.className = 'status error';
        status.textContent = `❌ Error: ${error.message}`;
    }
});

// Download buttons
document.getElementById('downloadYT').addEventListener('click', () => {
    chrome.storage.local.get('ytComments', (result) => {
        if (result.ytComments) {
            downloadJSON(result.ytComments, 'youtube-comments.json');
        }
    });
});

document.getElementById('downloadSpotify').addEventListener('click', () => {
    chrome.storage.local.get('spotifyTracks', (result) => {
        if (result.spotifyTracks) {
            downloadJSON(result.spotifyTracks, 'spotify-tracks.json');
        }
    });
});

// Copy buttons
document.getElementById('copyYT').addEventListener('click', async () => {
    const status = document.getElementById('ytStatus');
    chrome.storage.local.get('ytComments', async (result) => {
        if (!result.ytComments || result.ytComments.length === 0) {
            status.className = 'status error';
            status.textContent = '❌ No hay comentarios para copiar';
            return;
        }

        try {
            await copyToClipboard(JSON.stringify(result.ytComments, null, 2));
            status.className = 'status success';
            status.textContent = `✅ ${result.ytComments.length} comentarios copiados al portapapeles`;
        } catch (error) {
            status.className = 'status error';
            status.textContent = `❌ Error al copiar: ${error.message}`;
        }
    });
});

document.getElementById('copySpotify').addEventListener('click', async () => {
    const status = document.getElementById('spotifyStatus');
    chrome.storage.local.get('spotifyTracks', async (result) => {
        if (!result.spotifyTracks || result.spotifyTracks.length === 0) {
            status.className = 'status error';
            status.textContent = '❌ No hay canciones para copiar';
            return;
        }

        try {
            await copyToClipboard(JSON.stringify(result.spotifyTracks, null, 2));
            status.className = 'status success';
            status.textContent = `✅ ${result.spotifyTracks.length} canciones copiadas al portapapeles`;
        } catch (error) {
            status.className = 'status error';
            status.textContent = `❌ Error al copiar: ${error.message}`;
        }
    });
});

// Helper Functions
function showPreview(container, items, type) {
    container.innerHTML = '';
    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'preview-item';
        
        if (type === 'youtube') {
            div.innerHTML = `
                <strong>${item.author}</strong><br>
                <small>${item.date}</small><br>
                ${item.text.substring(0, 100)}...
            `;
        } else if (type === 'spotify') {
            div.innerHTML = `
                <strong>${item.trackName}</strong><br>
                ${item.artist}
            `;
        }
        
        container.appendChild(div);
    });
}

function downloadJSON(data, filename) {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);

    if (!ok) {
        throw new Error('El navegador no permitió copiar automáticamente');
    }
}
