import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// GITHUB_PAGES=1 builds a plain static site (dist/) for GitHub Pages instead of the
// Cloudflare worker bundle
// (and leaves out the original site's analytics tag)
const pages = {
	name: 'pages-no-analytics',
	transformIndexHtml: (html) => html
		.replace(/<script async src="https:\/\/www\.googletagmanager\.com[^]*?<\/script>\s*<script>[^]*?<\/script>/, ''),
};

export default defineConfig({
	plugins: process.env.GITHUB_PAGES ? [pages] : [cloudflare()],
});
