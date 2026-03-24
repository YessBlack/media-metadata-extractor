# Playlist & Comment Insights

Browser extension for structured extraction, normalization, and export of public metadata from YouTube and Spotify web pages.

This project was built as a personal engineering exercise and evolved into a practical tool for comment analytics workflows and playlist data organization.

## Overview

Web Content Scraper focuses on **data processing and interoperability**:

- Extracts YouTube comment metadata for analysis pipelines.
- Extracts Spotify playlist track metadata for cataloging and cleanup workflows.
- Normalizes output into machine-readable formats for BI, scripting, and research tasks.

The extension runs locally in the browser and is designed for iterative data collection on dynamic pages (virtualized lists, lazy-loaded comments, long-running sessions).

## Core Features

- **YouTube comment extraction**
  - Author, text, relative date, likes, reply flag, and extraction timestamp.
  - Progressive loading support for large comment sections.
  - Pause/resume controls and live progress updates.

- **Spotify playlist metadata extraction**
  - Track name, artist(s), album, duration, explicit flag, and extraction timestamp.
  - Handles long playlists with dynamic/virtualized DOM rendering.

- **Data export and handoff**
  - JSON export from the popup UI.
  - Quick copy-to-clipboard for ad hoc processing.
  - Output is ready for downstream conversion to CSV in Python, pandas, Sheets, or ETL tools.

- **Operational robustness**
  - Background-tolerant progress state for long extraction sessions.
  - Popup state restoration when reopening the extension UI.

## Example Data Patterns

### Input normalization example

Raw title-like string:

```text
01. Artist Name - Track Title (Official Video)
```

Normalized record shape:

```json
{
  "artist": "Artist Name",
  "trackName": "Track Title"
}
```

### YouTube output sample

```json
[
  {
    "author": "User A",
    "text": "Great breakdown of this topic.",
    "date": "hace 2 horas",
    "likes": "1.2K",
    "isReply": false,
    "timestamp": "2026-03-23T12:34:56.000Z"
  }
]
```

### Spotify output sample

```json
[
  {
    "trackName": "Track Title",
    "artist": "Artist A, Artist B",
    "album": "Album Name",
    "duration": "3:45",
    "explicit": false,
    "timestamp": "2026-03-23T12:34:56.000Z"
  }
]
```

## Installation

1. Clone or download this repository.
2. Open browser extensions page:
   - Chrome: `chrome://extensions/`
   - Brave: `brave://extensions/`
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project folder.

## Usage

### YouTube workflow

1. Open a YouTube video page (`/watch`).
2. Open the extension popup and select the **YouTube** tab.
3. Configure optional limit/batch values.
4. Click **Extraer Comentarios**.
5. Export the result as JSON or copy it for analysis.

### Spotify workflow

1. Open a Spotify web playlist.
2. Open the extension popup and select the **Spotify** tab.
3. Click **Extraer Canciones**.
4. Export the result as JSON or copy it for processing.

## Export & Analysis Workflow

- Primary export format: **JSON**.
- Typical next steps:
  - Convert JSON to CSV via Python/pandas.
  - Join playlist/comment data with other datasets.
  - Perform sentiment analysis, topic clustering, or engagement metrics.

## Tech Stack

- **JavaScript (Vanilla)**
- **Chrome Extensions API (Manifest V3)**
- **Content scripts + service worker architecture**
- **DOM observation and incremental extraction strategies**
- **Local storage state management for long-running tasks**

## Project Structure

```text
scrapping-extension/
├── manifest.json
├── popup.html
├── popup.js
├── content.js
├── background.js
├── styles.css
└── README.md
```

## Extensibility

The codebase is organized by concern (UI, background lifecycle, extraction logic), making it straightforward to:

- Add new source sites with dedicated extractors.
- Introduce additional output schemas.
- Integrate validation/cleaning steps before export.

## Responsible Use Disclaimer

This project is intended for **metadata extraction, formatting, and analytics workflows**.

- Use it in compliance with applicable laws, copyright regulations, and platform Terms of Service.
- Do not use this project to bypass subscriptions, access controls, or licensing restrictions.
- Respect user privacy and data protection requirements in your jurisdiction.

## License

This repository is for educational and portfolio purposes. Add your preferred open-source license before public distribution.
