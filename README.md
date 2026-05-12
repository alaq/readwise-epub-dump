# Readwise EPUB Dump

Client-only web app that turns your Readwise Reader articles into a single EPUB, with optional tagging and archiving.

## Features
- Fetch Reader documents with `withHtmlContent=true`
- Build a single EPUB in the browser
- Optional tag application and archive updates
- Best-effort image embedding for Kindle/iOS
- Optional generated magazine-style cover using OpenAI `gpt-image-2`, with title, date, and article lines

## Usage
1. Open `index.html` in your browser.
2. Get your token at https://readwise.io/access_token, click "Get Access Token", paste it in.
3. Choose location, optional tag prefix, and archive toggle.
4. Optionally upload a cover image, or enable generated covers and paste an OpenAI API key.
5. Click "Fetch and build EPUB" and download the result.

## Notes
- There is no backend server. Credentials are sent only from your browser to Readwise, and to OpenAI when generated covers are enabled.
- The Readwise token and OpenAI API key are stored locally only when their remember checkboxes are enabled.
- If an image host blocks CORS, that image may not embed.
- Generated covers use `gpt-image-2` through the OpenAI Images API.
- Cover image prompts use one selected article with a short excerpt. Full article text is not sent to OpenAI.

## License
MIT
