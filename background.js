// Service Worker for background tasks
// Listen for extension installation
chrome.runtime.onInstalled.addListener(() => {
    console.log('Web Content Scraper extension installed');
});

// Optional: Listen for tab updates to enable/disable icon based on URL
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
        // Check if the current tab is YouTube or Spotify
        const isSupported = tab.url && 
                           (tab.url.includes('youtube.com') || tab.url.includes('spotify.com'));
        
        if (isSupported) {
            chrome.action.enable(tabId);
        } else {
            chrome.action.disable(tabId);
        }
    }
});
