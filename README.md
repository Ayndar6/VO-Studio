# VO Studio

A browser-based voice-over practice booth. Paste a script, enable the microphone, record a take, then choose **Edit take**. Use the waveform and player to review the take, set trim points, and adjust gain. The optional 80 Hz low-cut filter reduces low-frequency rumble. Light compression reduces dynamic range.

Use **Original** and **Preview edits** to compare the two versions. **Export WAV** downloads a mono 16-bit PCM file at the recording sample rate. If the edited signal would exceed full scale, reduce Gain before exporting.

Scripts and original takes are stored in the current browser profile on the current device. Edit settings are session drafts. Export finished versions as WAV files to keep them independently of browser storage.

## Run locally

From the repository folder, run `python -m http.server 8000 --bind 127.0.0.1 --directory dist` and open <http://localhost:8000/> in Chrome or Edge. On Windows, try `py` in place of `python` if needed.

## Deploy privately

1. Create a private GitHub repository named `vo-studio` and push this folder's contents to it.
2. Connect the repository to Cloudflare Pages. Use `dist` as the output directory, with no build command.
3. Use a dedicated custom hostname. Create a Cloudflare Access self-hosted application for that hostname, enable one-time PIN login, and allow only the email addresses intended to use the studio.
4. Set up the production `pages.dev` redirect and ensure deployment preview URLs also require access. Before sharing the link, verify in a signed-out window that every hostname serving the studio redirects to the protected hostname or requires authentication. Test a permitted email as well.

The app performs audio capture, processing, and export on-device. The hosting service handles access to the app itself.
