# Readwise EPUB Dump

Client-only web app that turns your Readwise Reader articles into a single EPUB, with optional tagging and archiving.

## Features
- Fetch Reader documents with `withHtmlContent=true`
- Build a single EPUB in the browser
- Optional tag application and archive updates
- Best-effort image embedding for Kindle/iOS

## Usage
1. Open `index.html` in your browser.
2. Get your token at https://readwise.io/access_token, click "Get Access Token", paste it in.
3. Choose location, optional tag prefix, and archive toggle.
4. Click "Fetch and build EPUB" and download the result.

## Notes
- Everything runs locally in your browser. Your token never leaves your computer.
- If an image host blocks CORS, that image may not embed.

## License
MIT
