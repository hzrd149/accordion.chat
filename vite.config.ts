import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
	build: {
		rollupOptions: {
			input: {
				main: new URL("./index.html", import.meta.url).pathname,
				404: new URL("./404.html", import.meta.url).pathname,
			},
		},
	},
	// The applesauce-* packages are linked from a local monorepo (see
	// pnpm-workspace.yaml overrides), and applesauce-react's symlinked location
	// carries its own nested node_modules/react — so without deduping, the app and
	// applesauce-react load two different React copies ("Invalid hook call"). Force
	// a single instance from the app's node_modules.
	resolve: { dedupe: ["react", "react-dom"] },
	plugins: [
		tailwindcss(),
		react(),
		VitePWA({
			registerType: "autoUpdate",
			manifest: {
				name: "Accordion",
				short_name: "Accordion",
				description: "A Discord-style, end-to-end encrypted Concord community client over Nostr.",
				start_url: "/",
				scope: "/",
				display: "standalone",
				background_color: "#111827",
				theme_color: "#5865f2",
				icons: [
					{ src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
					{ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
					{ src: "/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
					{ src: "/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
					{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
				],
				categories: ["social", "communication"],
				lang: "en",
			},
		}),
	],
});
