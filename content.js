// Listen for messages from popup
const ytExtractionControl = {
    paused: false,
    running: false,
    lastCollected: 0,
    lastExpected: 0
};

function removeYTExtractionState() {
    try {
        chrome.storage.local.remove('ytExtractionState', () => {
            if (chrome.runtime.lastError) {
                // ignore
            }
        });
    } catch (error) {
        // ignore
    }
}

function saveYTExtractionState(state) {
    try {
        chrome.storage.local.set({ ytExtractionState: state }, () => {
            if (chrome.runtime.lastError) {
                console.warn('Failed to save extraction state:', chrome.runtime.lastError.message);
            }
        });
    } catch (error) {
        console.warn('Failed to save extraction state:', error);
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractYTComments') {
        ytExtractionControl.running = true;
        ytExtractionControl.paused = false;

        extractYouTubeComments(request.options || {}).then(data => {
            sendResponse({success: true, data: data});
            // Clear extraction state when complete
            removeYTExtractionState();
        }).catch(error => {
            sendResponse({success: false, error: error.message});
        }).finally(() => {
            ytExtractionControl.running = false;
            ytExtractionControl.paused = false;
        });
        return true; // Will respond asynchronously
    } else if (request.action === 'setYTPause') {
        ytExtractionControl.paused = !!request.paused;
        sendYTProgress({
            phase: ytExtractionControl.paused ? 'paused' : 'running',
            collected: ytExtractionControl.lastCollected,
            expected: ytExtractionControl.lastExpected
        });
        sendResponse({ success: true });
        return true;
    } else if (request.action === 'resumeMonitoring') {
        // Popup has reopened; send current state if extraction is running
        if (ytExtractionControl.running) {
            // We'll send progress on next update cycle
        }
        sendResponse({ success: true });
        return true;
    } else if (request.action === 'extractSpotify') {
        extractSpotifyTracks().then(data => {
            sendResponse({success: true, data: data});
        }).catch(error => {
            sendResponse({success: false, error: error.message});
        });
        return true; // Will respond asynchronously
    }
});

// YouTube Comments Extraction
async function extractYouTubeComments(options = {}) {
    const commentsMap = new Map();
    const limit = Math.max(Number.parseInt(options.limit || '0', 10) || 0, 0);
    const batchSize = Math.max(Number.parseInt(options.batchSize || '50', 10) || 50, 10);
    let lastProgressCount = 0;
    let lastProgressSentAt = 0;
    
    // Make sure we're on a YouTube page
    if (!window.location.hostname.includes('youtube.com')) {
        throw new Error('Esta página no es un video de YouTube');
    }

    if (!window.location.pathname.includes('/watch')) {
        throw new Error('Abre un video de YouTube en la vista /watch para extraer comentarios');
    }

    const commentsSection = await ensureYouTubeCommentsSectionLoaded();
    if (!commentsSection) {
        throw new Error('No se encontró la sección de comentarios. Puede estar desactivada para este video.');
    }

    const expectedTotal = getExpectedYouTubeCommentCount();
    const effectiveExpected = limit > 0 && expectedTotal > 0
        ? Math.min(limit, expectedTotal)
        : (limit > 0 ? limit : expectedTotal);

    collectVisibleYouTubeComments(commentsMap);
    maybeSendYTProgress();

    const startTime = Date.now();
    let lastGrowthAt = Date.now();
    const maxRuntimeMs = expectedTotal > 0 ? 21600000 : 10800000;
    const visibleGrowthIdleTimeoutMs = expectedTotal > 0 ? 180000 : 120000;
    const hiddenGrowthIdleTimeoutMs = expectedTotal > 0 ? 900000 : 420000;

    const onAnyActivity = (event) => {
        const before = commentsMap.size;
        collectVisibleYouTubeComments(commentsMap);
        if (commentsMap.size > before) {
            lastGrowthAt = Date.now();
        }
    };

    const observer = new MutationObserver(() => {
        const before = commentsMap.size;
        collectVisibleYouTubeComments(commentsMap);
        if (commentsMap.size > before) {
            lastGrowthAt = Date.now();
        }
    });

    window.addEventListener('scroll', onAnyActivity, { passive: true });
    window.addEventListener('wheel', onAnyActivity, { passive: true });
    window.addEventListener('touchmove', onAnyActivity, { passive: true });
    window.addEventListener('keydown', onAnyActivity);

    observer.observe(commentsSection instanceof HTMLElement ? commentsSection : document.body, {
        childList: true,
        subtree: true
    });

    try {
        let rounds = 0;
        const maxRounds = expectedTotal > 0
            ? Math.min(Math.max(Math.ceil(expectedTotal * 3), 4000), 40000)
            : 12000;

        while (Date.now() - startTime < maxRuntimeMs && rounds < maxRounds) {
            await waitIfYTPaused(commentsMap.size, effectiveExpected);

            const beforeCount = commentsMap.size;
            const previousScrollY = window.scrollY;

            if (rounds % 2 === 0) {
                expandVisibleYouTubeReplies();
            }
            if (rounds % 5 === 0) {
                expandVisibleYouTubeMoreButtons();
            }

            collectVisibleYouTubeComments(commentsMap);

            const step = Math.max(Math.floor(window.innerHeight * 0.92), 680);
            window.scrollBy(0, step);
            await new Promise(resolve => setTimeout(resolve, document.hidden ? 1700 : 850));

            collectVisibleYouTubeComments(commentsMap);
            maybeSendYTProgress();
            if (commentsMap.size > beforeCount) {
                lastGrowthAt = Date.now();
            }

            if (effectiveExpected > 0 && commentsMap.size >= effectiveExpected) {
                sendYTProgress({
                    phase: 'limit',
                    collected: commentsMap.size,
                    expected: effectiveExpected
                });
                break;
            }

            const reachedBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8;
            const scrollDidNotMove = Math.abs(window.scrollY - previousScrollY) < 2;

            if (reachedBottom && scrollDidNotMove) {
                window.scrollBy(0, -Math.max(Math.floor(window.innerHeight * 0.4), 320));
                await new Promise(resolve => setTimeout(resolve, document.hidden ? 700 : 300));
                window.scrollBy(0, Math.max(Math.floor(window.innerHeight * 0.8), 620));
                await new Promise(resolve => setTimeout(resolve, document.hidden ? 1600 : 700));
                collectVisibleYouTubeComments(commentsMap);
            }

            const growthIdleMs = Date.now() - lastGrowthAt;
            const growthIdleTimeoutMs = document.hidden ? hiddenGrowthIdleTimeoutMs : visibleGrowthIdleTimeoutMs;

            if (growthIdleMs > growthIdleTimeoutMs) {
                const beforeRecovery = commentsMap.size;

                for (let i = 0; i < 3; i++) {
                    expandVisibleYouTubeReplies();
                    expandVisibleYouTubeMoreButtons();
                    window.scrollBy(0, -Math.max(Math.floor(window.innerHeight * 0.5), 420));
                    await new Promise(resolve => setTimeout(resolve, document.hidden ? 1300 : 600));
                    window.scrollBy(0, Math.max(Math.floor(window.innerHeight * 1.1), 900));
                    await new Promise(resolve => setTimeout(resolve, document.hidden ? 2200 : 1100));
                }

                collectVisibleYouTubeComments(commentsMap);
                maybeSendYTProgress(true);

                if (commentsMap.size > beforeRecovery) {
                    lastGrowthAt = Date.now();
                } else if (effectiveExpected > 0 && commentsMap.size >= Math.floor(effectiveExpected * 0.98)) {
                    break;
                }
            }

            rounds++;
        }
    } finally {
        observer.disconnect();
        window.removeEventListener('scroll', onAnyActivity);
        window.removeEventListener('wheel', onAnyActivity);
        window.removeEventListener('touchmove', onAnyActivity);
        window.removeEventListener('keydown', onAnyActivity);
    }

    const comments = Array.from(commentsMap.values());

    if (comments.length === 0) {
        collectYouTubeCommentsFallback(commentsMap);
    }

    const finalComments = Array.from(commentsMap.values());

    if (limit > 0 && finalComments.length > limit) {
        return finalComments.slice(0, limit);
    }
    
    if (finalComments.length === 0) {
        throw new Error('No se pudieron extraer comentarios. Intenta de nuevo.');
    }
    
    return finalComments;

    function maybeSendYTProgress(force = false) {
        const now = Date.now();
        const heartbeatMs = document.hidden ? 12000 : 6000;
        const reachedBatch = commentsMap.size - lastProgressCount >= batchSize || commentsMap.size === 0;
        const reachedHeartbeat = now - lastProgressSentAt >= heartbeatMs;

        if (force || reachedBatch || reachedHeartbeat) {
            sendYTProgress({
                phase: 'running',
                collected: commentsMap.size,
                expected: effectiveExpected
            });
            lastProgressCount = commentsMap.size;
            lastProgressSentAt = now;
        }
    }
}

async function waitIfYTPaused(collected, expected) {
    while (ytExtractionControl.running && ytExtractionControl.paused) {
        sendYTProgress({
            phase: 'paused',
            collected,
            expected
        });
        await new Promise(resolve => setTimeout(resolve, 400));
    }
}

function sendYTProgress(payload) {
    ytExtractionControl.lastCollected = Number(payload?.collected || 0);
    ytExtractionControl.lastExpected = Number(payload?.expected || 0);

    try {
        chrome.runtime.sendMessage({
            action: 'ytExtractionProgress',
            payload
        });
    } catch (error) {
        // Popup might be closed; ignore.
    }
    
    // Save state to storage for persistence when popup closes
    const videoUrl = window.location.href;
    const videoId = new URL(videoUrl).searchParams.get('v') || 'unknown';
    
    saveYTExtractionState({
        videoId,
        videoUrl,
        phase: payload.phase || 'running',
        collected: payload.collected || 0,
        expected: payload.expected || 0,
        running: !!ytExtractionControl.running,
        paused: payload.phase === 'paused',
        timestamp: Date.now()
    });
}

// Spotify Tracks Extraction
async function extractSpotifyTracks() {
    if (!window.location.hostname.includes('spotify.com')) {
        throw new Error('Esta página no es Spotify');
    }

    const playlistId = getSpotifyPlaylistIdFromUrl(window.location.href);
    if (playlistId) {
        try {
            const apiTracks = await extractSpotifyTracksFromWebApi(playlistId);
            if (apiTracks.length > 0) {
                return apiTracks;
            }
        } catch (error) {
            console.warn('Spotify API extraction failed, falling back to DOM:', error);
        }
    }

    return extractSpotifyTracksFromDom();
}

async function extractSpotifyTracksFromDom() {
    const tracksByPosition = new Map();

    const trackElements = document.querySelectorAll('[role="row"][aria-rowindex] [data-testid="tracklist-row"], [role="row"][aria-rowindex]');

    if (trackElements.length === 0) {
        throw new Error('No se encontraron canciones. Asegúrate de estar en una lista de reproducción.');
    }

    const firstRow = trackElements[0];
    const trackRoot = getSpotifyTrackRoot(firstRow);
    const expectedTotal = getExpectedSpotifyTrackCount(trackRoot);
    const viewportDriver = await resolveSpotifySongViewport(trackRoot, firstRow);

    if (trackRoot instanceof HTMLElement) {
        trackRoot.focus({ preventScroll: true });
        scrollSpotifyTrackRootIntoView(trackRoot);
    }

    resetSpotifyDriverToTop(viewportDriver, trackRoot);

    await new Promise(resolve => setTimeout(resolve, 450));
    collectVisibleSpotifyTracksByPosition(tracksByPosition, trackRoot);

    const startTime = Date.now();
    let lastGrowthAt = Date.now();
    let lastInteractionAt = Date.now();
    const maxRuntimeMs = expectedTotal > 0 ? 180000 : 120000;
    const idleTimeoutMs = expectedTotal > 0 ? 18000 : 12000;
    const interactionGraceMs = 22000;

    const onAnyScroll = () => {
        lastInteractionAt = Date.now();
        const before = tracksByPosition.size;
        collectVisibleSpotifyTracksByPosition(tracksByPosition, trackRoot);
        if (tracksByPosition.size > before) {
            lastGrowthAt = Date.now();
        }
    };

    const onUserInput = (event) => {
        if (event.isTrusted) {
            lastInteractionAt = Date.now();
        }
    };

    const observer = new MutationObserver(() => {
        const before = tracksByPosition.size;
        collectVisibleSpotifyTracksByPosition(tracksByPosition, trackRoot);
        if (tracksByPosition.size > before) {
            lastGrowthAt = Date.now();
        }
    });

    window.addEventListener('scroll', onAnyScroll, { passive: true });
    window.addEventListener('wheel', onUserInput, { passive: true });
    window.addEventListener('keydown', onUserInput);
    window.addEventListener('touchmove', onUserInput, { passive: true });
    if (trackRoot instanceof HTMLElement) {
        trackRoot.addEventListener('scroll', onAnyScroll, { passive: true });
        trackRoot.addEventListener('wheel', onUserInput, { passive: true });
    }
    if (viewportDriver.type === 'element' && viewportDriver.element) {
        viewportDriver.element.addEventListener('scroll', onAnyScroll, { passive: true });
    }
    observer.observe(trackRoot instanceof HTMLElement ? trackRoot : document.body, {
        childList: true,
        subtree: true
    });

    try {
        let iteration = 0;
        while (Date.now() - startTime < maxRuntimeMs) {
            if (expectedTotal > 0 && tracksByPosition.size >= expectedTotal) {
                break;
            }

            const growthIdleMs = Date.now() - lastGrowthAt;
            const interactionIdleMs = Date.now() - lastInteractionAt;
            if (growthIdleMs > idleTimeoutMs && interactionIdleMs > interactionGraceMs) {
                break;
            }

            const beforeCount = tracksByPosition.size;
            const beforeMaxPos = getMaxVisibleSpotifyRowPosition(trackRoot);

            advanceSpotifyGridViewport(trackRoot, viewportDriver);
            await new Promise(resolve => setTimeout(resolve, 320));
            collectVisibleSpotifyTracksByPosition(tracksByPosition, trackRoot);

            const afterMaxPos = getMaxVisibleSpotifyRowPosition(trackRoot);
            const moved = afterMaxPos > beforeMaxPos || tracksByPosition.size > beforeCount;

            if (moved) {
                lastGrowthAt = Date.now();
            } else {
                const step = Math.max(Math.floor(window.innerHeight * 0.9), 640);
                forceAdvanceSpotifyRows(trackRoot, step, viewportDriver);
                await new Promise(resolve => setTimeout(resolve, 220));
                const beforeForceCollect = tracksByPosition.size;
                collectVisibleSpotifyTracksByPosition(tracksByPosition, trackRoot);
                if (tracksByPosition.size > beforeForceCollect) {
                    lastGrowthAt = Date.now();
                }
            }

            iteration++;

            if (iteration % 20 === 0) {
                window.scrollBy(0, -Math.max(Math.floor(window.innerHeight * 0.35), 220));
                await new Promise(resolve => setTimeout(resolve, 150));
            }
        }
    } finally {
        observer.disconnect();
        window.removeEventListener('scroll', onAnyScroll);
        window.removeEventListener('wheel', onUserInput);
        window.removeEventListener('keydown', onUserInput);
        window.removeEventListener('touchmove', onUserInput);
        if (trackRoot instanceof HTMLElement) {
            trackRoot.removeEventListener('scroll', onAnyScroll);
            trackRoot.removeEventListener('wheel', onUserInput);
        }
        if (viewportDriver.type === 'element' && viewportDriver.element) {
            viewportDriver.element.removeEventListener('scroll', onAnyScroll);
        }
    }

    const tracks = Array.from(tracksByPosition.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, track]) => track);

    if (tracks.length === 0) {
        throw new Error('No se pudieron extraer canciones. Intenta de nuevo.');
    }

    return tracks;
}

async function resolveSpotifySongViewport(trackRoot, firstRow) {
    const candidates = [];

    if (trackRoot instanceof HTMLElement) {
        candidates.push({ type: 'element', element: trackRoot });
    }

    let node = firstRow?.parentElement || trackRoot?.parentElement || null;
    while (node && node !== document.body) {
        if (isElementScrollable(node)) {
            candidates.push({ type: 'element', element: node });
        }
        node = node.parentElement;
    }

    candidates.push({ type: 'window', element: null });

    const unique = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const key = candidate.type === 'window'
            ? 'window'
            : `element-${getElementStableId(candidate.element)}`;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(candidate);
        }
    }

    for (const driver of unique) {
        const before = getMaxVisibleSpotifyRowPosition(trackRoot);
        const previousOffset = getSpotifyDriverOffset(driver);
        const step = Math.max(Math.floor(getSpotifyDriverViewportHeight(driver) * 0.55), 220);

        driveSpotifyDriver(driver, step, trackRoot);
        await new Promise(resolve => setTimeout(resolve, 180));
        const after = getMaxVisibleSpotifyRowPosition(trackRoot);

        setSpotifyDriverOffset(driver, previousOffset, trackRoot);
        await new Promise(resolve => setTimeout(resolve, 80));

        if (after > before) {
            return driver;
        }
    }

    return { type: 'window', element: null };
}

function isElementScrollable(element) {
    if (!element) {
        return false;
    }

    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY;
    const scrollable = overflowY === 'auto' || overflowY === 'scroll';
    return scrollable && element.scrollHeight > element.clientHeight + 4;
}

function resetSpotifyDriverToTop(driver, trackRoot) {
    setSpotifyDriverOffset(driver, 0, trackRoot);
}

function setSpotifyDriverOffset(driver, value, trackRoot) {
    if (driver.type === 'element' && driver.element) {
        driver.element.scrollTop = value;
        return;
    }

    if (value === 0) {
        scrollSpotifyTrackRootIntoView(trackRoot);
    } else {
        window.scrollTo({ top: value, behavior: 'auto' });
    }
}

function driveSpotifyDriver(driver, step, trackRoot) {
    if (driver.type === 'element' && driver.element) {
        const before = driver.element.scrollTop;
        driver.element.scrollTop = before + step;

        if (Math.abs(driver.element.scrollTop - before) < 1) {
            try {
                driver.element.dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true, cancelable: true }));
            } catch (e) {
                // ignore
            }
            driver.element.scrollTop = before + step;
        }
        return;
    }

    scrollSpotifyTrackRootIntoView(trackRoot);
    window.scrollBy(0, step);
}

function getSpotifyPlaylistIdFromUrl(url) {
    const match = url.match(/\/playlist\/([A-Za-z0-9]+)/);
    return match?.[1] || '';
}

async function getSpotifyAccessToken() {
    const response = await fetch('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', {
        method: 'GET',
        credentials: 'include'
    });

    if (!response.ok) {
        throw new Error(`No se pudo obtener token de Spotify (${response.status})`);
    }

    const data = await response.json();
    if (!data?.accessToken) {
        throw new Error('Token de Spotify no disponible');
    }

    return data.accessToken;
}

async function extractSpotifyTracksFromWebApi(playlistId) {
    const token = await getSpotifyAccessToken();
    const tracks = [];
    let offset = 0;
    const limit = 100;

    while (true) {
        const endpoint = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?offset=${offset}&limit=${limit}&additional_types=track&market=from_token`;
        const response = await fetch(endpoint, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        if (!response.ok) {
            throw new Error(`Spotify API respondió ${response.status}`);
        }

        const payload = await response.json();
        const items = Array.isArray(payload?.items) ? payload.items : [];

        for (const item of items) {
            const track = item?.track;
            if (!track || track.type !== 'track') {
                continue;
            }

            tracks.push({
                trackName: track.name || 'Desconocido',
                artist: Array.isArray(track.artists) ? track.artists.map(artist => artist?.name).filter(Boolean).join(', ') : 'Desconocido',
                album: track.album?.name || 'Desconocido',
                duration: formatSpotifyDuration(track.duration_ms),
                explicit: !!track.explicit,
                timestamp: new Date().toISOString()
            });
        }

        if (!payload?.next || items.length === 0) {
            break;
        }

        offset += limit;
    }

    return tracks;
}

function formatSpotifyDuration(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return 'Desconocida';
    }

    const totalSeconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Helper functions
function getLikesCount(element) {
    try {
        const voteCount =
            element.querySelector('#vote-count-middle') ||
            element.querySelector('#vote-count-left') ||
            element.querySelector('span[aria-label*="like"]');

        const text = voteCount?.textContent?.trim();
        if (text) {
            return text;
        }
    } catch (e) {}
    return '0';
}

function isCommentReply(element) {
    return (
        element.hasAttribute('is-reply') ||
        element.classList.contains('reply-item') ||
        !!element.closest('ytd-comment-replies-renderer')
    );
}

function collectVisibleYouTubeComments(commentsMap) {
    const commentElements = document.querySelectorAll('ytd-comment-renderer, ytd-comment-view-model');

    for (const element of commentElements) {
        try {
            const author = getYouTubeAuthor(element);
            const text = getYouTubeCommentText(element);
            const date = getYouTubeCommentDate(element);
            const commentId = getYouTubeCommentId(element);

            if (!author || !text) {
                continue;
            }

            const key = commentId || `${author}__${text}__${date}`;
            if (!commentsMap.has(key)) {
                commentsMap.set(key, {
                    id: commentId || undefined,
                    author,
                    text,
                    date,
                    likes: getLikesCount(element),
                    isReply: isCommentReply(element),
                    timestamp: new Date().toISOString()
                });
            }
        } catch (e) {
            console.log('Error extracting comment:', e);
        }
    }
}

function getYouTubeCommentId(element) {
    const permalink =
        element.querySelector('#published-time-text a[href*="lc="]') ||
        element.querySelector('a[href*="lc="]');
    const href = permalink?.getAttribute('href') || '';
    const match = href.match(/[?&]lc=([^&]+)/);
    return match?.[1] || '';
}

function getYouTubeAuthor(element) {
    const authorEl =
        element.querySelector('[id="author-text"] span') ||
        element.querySelector('#author-text span') ||
        element.querySelector('#author-text') ||
        element.querySelector('a[href*="/@"]') ||
        element.querySelector('a[href*="/channel/"]') ||
        element.querySelector('#author-name a') ||
        element.querySelector('#header-author a');

    return authorEl?.textContent?.trim() || '';
}

function getYouTubeCommentText(element) {
    const textEl =
        element.querySelector('yt-attributed-string#content-text') ||
        element.querySelector('#content-text') ||
        element.querySelector('#content-text span') ||
        element.querySelector('[id="content-text"] yt-attributed-string') ||
        element.querySelector('yt-formatted-string#content-text');

    return textEl?.textContent?.trim() || '';
}

function getYouTubeCommentDate(element) {
    const dateEl =
        element.querySelector('yt-formatted-string.published-time-text a') ||
        element.querySelector('#published-time-text a') ||
        element.querySelector('a[aria-label*="ago"]') ||
        element.querySelector('a[aria-label*="hace"]') ||
        element.querySelector('a[href*="lc="]');

    return dateEl?.textContent?.trim() || 'Desconocida';
}

async function ensureYouTubeCommentsSectionLoaded() {
    for (let i = 0; i < 8; i++) {
        const commentsContainer =
            document.querySelector('#comments') ||
            document.querySelector('ytd-comments') ||
            document.querySelector('ytd-item-section-renderer#sections');

        if (commentsContainer) {
            commentsContainer.scrollIntoView({ behavior: 'auto', block: 'start' });
            await new Promise(resolve => setTimeout(resolve, 500));

            const hasAnyThread = document.querySelectorAll('ytd-comment-thread-renderer, ytd-comment-renderer, ytd-comment-view-model').length > 0;
            if (hasAnyThread) {
                return commentsContainer;
            }
        }

        window.scrollBy(0, Math.max(Math.floor(window.innerHeight * 0.9), 700));
        await new Promise(resolve => setTimeout(resolve, 600));
    }

    return null;
}

function expandVisibleYouTubeReplies() {
    const replyButtons = document.querySelectorAll(
        'ytd-button-renderer #button[aria-label*="respuestas"], ' +
        'ytd-button-renderer #button[aria-label*="replies"], ' +
        'ytd-comment-replies-renderer #more-replies, ' +
        '#more-replies #button'
    );

    for (const button of Array.from(replyButtons).slice(0, 120)) {
        try {
            if (button instanceof HTMLElement && button.offsetParent !== null) {
                button.click();
            }
        } catch (e) {
            // Ignore click issues.
        }
    }
}

function expandVisibleYouTubeMoreButtons() {
    const buttons = document.querySelectorAll(
        '#more-replies #button, ' +
        '#more-text #button, ' +
        'tp-yt-paper-button#more, ' +
        'ytd-comment-renderer #more'
    );

    for (const button of Array.from(buttons).slice(0, 80)) {
        try {
            if (button instanceof HTMLElement && button.offsetParent !== null) {
                button.click();
            }
        } catch (e) {
            // Ignore click issues.
        }
    }
}

function getExpectedYouTubeCommentCount() {
    const candidates = [
        '#count yt-formatted-string.count-text',
        '#count .count-text',
        'ytd-comments-header-renderer #count',
        '#comments #count'
    ];

    for (const selector of candidates) {
        const el = document.querySelector(selector);
        const text = el?.textContent?.trim() || '';
        const parsed = parseCountFromText(text);
        if (parsed > 0) {
            return parsed;
        }
    }

    return 0;
}

function parseCountFromText(text) {
    if (!text) {
        return 0;
    }

    const normalized = text
        .replace(/\s+/g, ' ')
        .replace(/comentarios?|comments?/gi, '')
        .trim();

    const compact = normalized.replace(/[^\d.,]/g, '');
    if (!compact) {
        return 0;
    }

    const withDotsRemoved = compact.replace(/\./g, '');
    const withCommasAsThousands = withDotsRemoved.replace(/,/g, '');
    const value = Number.parseInt(withCommasAsThousands, 10);

    return Number.isFinite(value) ? value : 0;
}

function collectYouTubeCommentsFallback(commentsMap) {
    const threads = document.querySelectorAll('ytd-comment-thread-renderer');

    for (const thread of threads) {
        try {
            const author =
                thread.querySelector('#author-text span')?.textContent?.trim() ||
                thread.querySelector('a[href*="/@"]')?.textContent?.trim() ||
                '';

            const text =
                thread.querySelector('#content-text')?.textContent?.trim() ||
                thread.querySelector('yt-attributed-string#content-text')?.textContent?.trim() ||
                '';

            const date =
                thread.querySelector('#published-time-text a')?.textContent?.trim() ||
                'Desconocida';

            if (!author || !text) {
                continue;
            }

            const key = `${author}__${text}__${date}`;
            if (!commentsMap.has(key)) {
                commentsMap.set(key, {
                    author,
                    text,
                    date,
                    likes: getLikesCount(thread),
                    isReply: false,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (e) {
            console.log('Fallback comment extraction error:', e);
        }
    }
}

function getDurationFromElement(element) {
    try {
        const durationCell =
            element.querySelector('[data-testid="track-duration"]') ||
            element.querySelector('[data-testid="duration"]') ||
            element.querySelector('div[aria-colindex="5"], div[aria-colindex="4"]');
        return durationCell ? durationCell.textContent.trim() : 'Desconocida';
    } catch (e) {}
    return 'Desconocida';
}

function isTrackExplicit(element) {
    try {
        return (
            !!element.querySelector('[aria-label*="Explicit"], [title*="Explicit"]') ||
            element.innerHTML.includes('explicit')
        );
    } catch (e) {}
    return false;
}

function getTrackNameFromRow(element) {
    const candidates = [
        '[data-testid="internal-track-link"]',
        'a[href*="/track/"]',
        '[data-testid="track-name"]'
    ];

    for (const selector of candidates) {
        const el = element.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text) {
            return text;
        }
    }

    return '';
}

function getArtistFromRow(element) {
    const artistLinks = element.querySelectorAll('[data-testid*="artist-link"], a[href*="/artist/"]');
    if (artistLinks.length > 0) {
        const artists = Array.from(artistLinks)
            .map(link => link.textContent?.trim())
            .filter(Boolean);
        if (artists.length > 0) {
            return artists.join(', ');
        }
    }

    return '';
}

function getAlbumFromRow(element) {
    const albumLink = element.querySelector('a[href*="/album/"]');
    const album = albumLink?.textContent?.trim();
    return album || 'Desconocido';
}

function collectVisibleSpotifyTracksByPosition(tracksByPosition, trackRoot) {
    const root = trackRoot || document;
    const rows = root.querySelectorAll('[role="row"][aria-rowindex]');

    for (const row of rows) {
        try {
            const rowPosition = getSpotifyRowPositionFromRowContainer(row);
            if (!rowPosition || rowPosition < 1) {
                continue;
            }

            const element = row.querySelector('[data-testid="tracklist-row"]') || row;
            const trackName = getTrackNameFromRow(element);
            const artist = getArtistFromRow(element) || 'Desconocido';
            const album = getAlbumFromRow(element);

            if (!trackName) {
                continue;
            }

            const duration = getDurationFromElement(element);

            const current = tracksByPosition.get(rowPosition);
            if (!current || (current.artist === 'Desconocido' && artist !== 'Desconocido')) {
                tracksByPosition.set(rowPosition, {
                    trackName,
                    artist,
                    album,
                    duration,
                    explicit: isTrackExplicit(element),
                    timestamp: new Date().toISOString()
                });
            }
        } catch (e) {
            console.log('Error collecting visible track:', e);
        }
    }
}

function getExpectedSpotifyTrackCount(trackRoot) {
    const grid =
        (trackRoot?.matches?.('[role="grid"][data-testid="playlist-tracklist"]') ? trackRoot : null) ||
        trackRoot?.querySelector?.('[role="grid"][data-testid="playlist-tracklist"][aria-rowcount]') ||
        document.querySelector('[role="grid"][data-testid="playlist-tracklist"][aria-rowcount]') ||
        document.querySelector('[role="grid"][aria-rowcount]');
    const raw = grid?.getAttribute('aria-rowcount');
    const count = Number.parseInt(raw || '', 10);

    if (Number.isFinite(count) && count > 0) {
        // Some grids include header row in aria-rowcount.
        return Math.max(count - 1, 1);
    }

    const countTextCandidates = [
        '[data-testid="entityTitle"] + div',
        'main [data-testid="playlist-page"]',
        'main'
    ];

    for (const selector of countTextCandidates) {
        const text = document.querySelector(selector)?.textContent || '';
        const match = text.match(/(\d{1,3}(?:[.,]\d{3})*|\d+)\s+canciones/i) || text.match(/(\d{1,3}(?:[.,]\d{3})*|\d+)\s+songs/i);
        if (match?.[1]) {
            const numeric = Number.parseInt(match[1].replace(/[.,]/g, ''), 10);
            if (Number.isFinite(numeric) && numeric > 0) {
                return numeric;
            }
        }
    }

    return 0;
}

function getSpotifyScrollContainer(firstRow) {
    if (!firstRow) {
        return null;
    }

    const trackRoot = getSpotifyTrackRoot(firstRow);
    const candidates = [];

    if (trackRoot) {
        candidates.push(trackRoot);
    }

    let node = firstRow.parentElement;
    while (node && node !== document.body) {
        const style = window.getComputedStyle(node);
        const overflowY = style.overflowY;
        const isScrollableStyle = overflowY === 'auto' || overflowY === 'scroll';
        const canScroll = node.scrollHeight > node.clientHeight + 4;
        if (canScroll && isScrollableStyle) {
            candidates.push(node);
        }
        node = node.parentElement;
    }

    const docScroller = document.scrollingElement || document.documentElement;
    if (docScroller) {
        candidates.push(docScroller);
    }

    for (const candidate of candidates) {
        if (doesSpotifyScrollContainerMoveRows(candidate, trackRoot)) {
            return candidate;
        }
    }

    if (candidates.length > 0) {
        return candidates[0];
    }

    return docScroller || null;
}

async function resolveSpotifyScrollDriver(firstRow, trackRoot) {
    const candidates = [];

    const direct = getSpotifyScrollContainer(firstRow, trackRoot);
    if (direct) {
        candidates.push({ type: 'element', element: direct });
    }

    if (trackRoot instanceof HTMLElement) {
        candidates.push({ type: 'element', element: trackRoot });
    }

    const scrollEl = document.scrollingElement || document.documentElement;
    if (scrollEl) {
        candidates.push({ type: 'window' });
    }

    const unique = dedupeSpotifyDrivers(candidates);

    for (const driver of unique) {
        const works = await canDriveSpotifyRowsWithDriver(driver, trackRoot);
        if (works) {
            return driver;
        }
    }

    return { type: 'window' };
}

function dedupeSpotifyDrivers(drivers) {
    const seen = new Set();
    const output = [];

    for (const driver of drivers) {
        const key = driver.type === 'window'
            ? 'window'
            : `el-${getElementStableId(driver.element)}`;
        if (!seen.has(key)) {
            seen.add(key);
            output.push(driver);
        }
    }

    return output;
}

function getElementStableId(element) {
    if (!element) {
        return 'none';
    }

    if (!element.dataset.scraperId) {
        element.dataset.scraperId = `sc-${Math.random().toString(36).slice(2, 10)}`;
    }

    return element.dataset.scraperId;
}

function resetSpotifyScrollDriverToTop(driver, trackRoot) {
    if (driver?.type === 'element' && driver.element) {
        driver.element.scrollTop = 0;
    } else {
        scrollSpotifyTrackRootIntoView(trackRoot);
    }
}

function getSpotifyDriverOffset(driver) {
    if (driver?.type === 'element' && driver.element) {
        return driver.element.scrollTop;
    }

    return window.scrollY;
}

function getSpotifyDriverViewportHeight(driver) {
    if (driver?.type === 'element' && driver.element) {
        return driver.element.clientHeight || window.innerHeight;
    }

    return window.innerHeight;
}

function driveSpotifyScroll(driver, step, trackRoot) {
    if (driver?.type === 'element' && driver.element) {
        const target = driver.element;
        const beforeTop = target.scrollTop;
        target.scrollTop = beforeTop + step;

        // Some Spotify containers react better to wheel events.
        try {
            target.dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true, cancelable: true }));
        } catch (e) {
            // ignore
        }

        // If the chosen element does not move, fallback to window scroll for this step.
        if (Math.abs(target.scrollTop - beforeTop) < 1) {
            scrollSpotifyTrackRootIntoView(trackRoot);
            window.scrollBy(0, step);
        }
        return;
    }

    scrollSpotifyTrackRootIntoView(trackRoot);
    window.scrollBy(0, step);
}

function isSpotifyDriverAtBottom(driver) {
    if (driver?.type === 'element' && driver.element) {
        return driver.element.scrollTop + driver.element.clientHeight >= driver.element.scrollHeight - 6;
    }

    return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 6;
}

function getSpotifyTrackRoot(firstRow) {
    const explicitGrid = document.querySelector('[role="grid"][data-testid="playlist-tracklist"]');
    if (explicitGrid) {
        return explicitGrid;
    }

    if (firstRow) {
        const byGrid = firstRow.closest('[role="grid"][data-testid="playlist-tracklist"]') || firstRow.closest('[role="grid"]');
        if (byGrid) {
            return byGrid;
        }

        const byTrackList = firstRow.closest('[data-testid="playlist-tracklist"]');
        if (byTrackList) {
            return byTrackList;
        }
    }

    return document.querySelector('[role="grid"]') || document;
}

async function canDriveSpotifyRowsWithDriver(driver, trackRoot) {
    if (!driver || !trackRoot) {
        return false;
    }

    const before = getMaxVisibleSpotifyRowPosition(trackRoot);
    const probeStep = Math.max(Math.floor(getSpotifyDriverViewportHeight(driver) * 0.6), 220);
    const previousOffset = getSpotifyDriverOffset(driver);

    driveSpotifyScroll(driver, probeStep, trackRoot);
    await new Promise(resolve => setTimeout(resolve, 300));
    const after = getMaxVisibleSpotifyRowPosition(trackRoot);

    if (driver.type === 'element' && driver.element) {
        driver.element.scrollTop = previousOffset;
    } else {
        window.scrollTo({ top: previousOffset, behavior: 'auto' });
    }
    await new Promise(resolve => setTimeout(resolve, 140));

    return after > before;
}

function scrollSpotifyTrackRootIntoView(trackRoot) {
    if (!trackRoot || !(trackRoot instanceof HTMLElement)) {
        return;
    }

    const top = trackRoot.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(top - 120, 0), behavior: 'auto' });
}

function forceAdvanceSpotifyRows(trackRoot, step, viewportDriver) {
    if (viewportDriver) {
        driveSpotifyDriver(viewportDriver, step, trackRoot);
    }

    if (!(trackRoot instanceof HTMLElement)) {
        return;
    }

    let node = trackRoot;
    let attempts = 0;

    while (node && node !== document.body && attempts < 6) {
        const style = window.getComputedStyle(node);
        const overflowY = style.overflowY;
        const canScroll = node.scrollHeight > node.clientHeight + 4;
        const scrollable = overflowY === 'auto' || overflowY === 'scroll';

        if (canScroll && scrollable) {
            const before = node.scrollTop;
            node.scrollTop = before + step;
            if (Math.abs(node.scrollTop - before) > 0) {
                return;
            }
        }

        node = node.parentElement;
        attempts++;
    }

    try {
        trackRoot.dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true, cancelable: true }));
    } catch (e) {
        // ignore
    }
}

function advanceSpotifyGridViewport(trackRoot, viewportDriver) {
    if (viewportDriver) {
        driveSpotifyDriver(viewportDriver, Math.max(Math.floor(getSpotifyDriverViewportHeight(viewportDriver) * 0.7), 260), trackRoot);
    }

    if (!(trackRoot instanceof HTMLElement)) {
        window.scrollBy(0, Math.max(Math.floor(window.innerHeight * 0.8), 520));
        return;
    }

    trackRoot.focus({ preventScroll: true });

    const pageDownEvent = new KeyboardEvent('keydown', {
        key: 'PageDown',
        code: 'PageDown',
        keyCode: 34,
        which: 34,
        bubbles: true,
        cancelable: true
    });

    try {
        trackRoot.dispatchEvent(pageDownEvent);
    } catch (e) {
        // ignore
    }

    try {
        document.dispatchEvent(pageDownEvent);
    } catch (e) {
        // ignore
    }

    const wheelDelta = Math.max(Math.floor(window.innerHeight * 0.85), 600);
    try {
        trackRoot.dispatchEvent(new WheelEvent('wheel', { deltaY: wheelDelta, bubbles: true, cancelable: true }));
    } catch (e) {
        // ignore
    }

    // Fallback generic scroll movement.
    forceAdvanceSpotifyRows(trackRoot, wheelDelta);
    window.scrollBy(0, Math.floor(wheelDelta * 0.4));
}

function getSpotifyScrollDrivers(firstRow, trackRoot) {
    const drivers = [{ type: 'window', element: null }];

    if (trackRoot instanceof HTMLElement) {
        drivers.push({ type: 'element', element: trackRoot });
    }

    let node = firstRow?.parentElement || null;
    while (node && node !== document.body) {
        const style = window.getComputedStyle(node);
        const overflowY = style.overflowY;
        const canScroll = node.scrollHeight > node.clientHeight + 4;
        const scrollable = overflowY === 'auto' || overflowY === 'scroll';
        if (canScroll && scrollable) {
            drivers.push({ type: 'element', element: node });
        }
        node = node.parentElement;
    }

    const unique = [];
    const seen = new Set();
    for (const driver of drivers) {
        const key = driver.type === 'window'
            ? 'window'
            : `element-${getElementStableId(driver.element)}`;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(driver);
        }
    }

    return unique;
}

async function runSpotifyCollectionPass({ driver, trackRoot, tracksByPosition, expectedTotal, stepFactor }) {
    if (driver.type === 'window') {
        scrollSpotifyTrackRootIntoView(trackRoot);
    } else if (driver.element) {
        driver.element.scrollTop = 0;
    }

    await new Promise(resolve => setTimeout(resolve, 450));
    collectVisibleSpotifyTracksByPosition(tracksByPosition, trackRoot);

    let stagnant = 0;
    const maxStagnant = expectedTotal > 0 ? 30 : 40;
    const maxSteps = expectedTotal > 0
        ? Math.min(Math.max(expectedTotal * 2, 180), 1600)
        : 700;

    for (let stepIndex = 0; stepIndex < maxSteps && stagnant < maxStagnant; stepIndex++) {
        const beforeCount = tracksByPosition.size;
        const beforeMaxPos = getMaxVisibleSpotifyRowPosition(trackRoot);
        const viewport = driver.type === 'window'
            ? window.innerHeight
            : (driver.element?.clientHeight || window.innerHeight);
        const delta = Math.max(Math.floor(viewport * stepFactor), 220);

        if (driver.type === 'window') {
            window.scrollBy(0, delta);
        } else if (driver.element) {
            const beforeTop = driver.element.scrollTop;
            driver.element.scrollTop = beforeTop + delta;
            if (Math.abs(driver.element.scrollTop - beforeTop) < 1) {
                forceAdvanceSpotifyRows(trackRoot, delta);
            }
        }

        await new Promise(resolve => setTimeout(resolve, 420));
        collectVisibleSpotifyTracksByPosition(tracksByPosition, trackRoot);

        const afterMaxPos = getMaxVisibleSpotifyRowPosition(trackRoot);
        const grew = tracksByPosition.size > beforeCount || afterMaxPos > beforeMaxPos;
        stagnant = grew ? 0 : stagnant + 1;

        if (expectedTotal > 0 && tracksByPosition.size >= expectedTotal) {
            break;
        }

        const atBottom = driver.type === 'window'
            ? (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 6)
            : !!driver.element && (driver.element.scrollTop + driver.element.clientHeight >= driver.element.scrollHeight - 6);

        if (atBottom && !grew) {
            break;
        }
    }
}

function doesSpotifyScrollContainerMoveRows(container, trackRoot) {
    if (!container || !trackRoot) {
        return false;
    }

    const before = getMaxVisibleSpotifyRowPosition(trackRoot);
    const previousTop = container.scrollTop;
    const delta = Math.max(Math.floor(container.clientHeight * 0.5), 180);

    container.scrollTop = previousTop + delta;
    const after = getMaxVisibleSpotifyRowPosition(trackRoot);
    container.scrollTop = previousTop;

    return after > before;
}

function getMaxVisibleSpotifyRowPosition(trackRoot) {
    const rows = trackRoot.querySelectorAll('[role="row"][aria-rowindex]');
    let max = 0;

    for (const row of rows) {
        const position = getSpotifyRowPositionFromRowContainer(row);
        if (position > max) {
            max = position;
        }
    }

    return max;
}

function getSpotifyRowPositionFromRowContainer(rowElement) {
    const aria = rowElement.getAttribute('aria-rowindex');
    if (aria) {
        const value = Number.parseInt(aria, 10);
        if (Number.isFinite(value)) {
            // aria-rowindex includes header row as 1.
            return Math.max(value - 1, 1);
        }
    }

    const numberCell = rowElement.querySelector('[aria-colindex="1"], [data-testid="tracklist-row-number"]');
    const raw = numberCell?.textContent?.trim() || '';
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
        return parsed;
    }

    return 0;
}
