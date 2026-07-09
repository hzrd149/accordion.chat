import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
	// The applesauce-* packages are linked from a local monorepo (see
	// pnpm-workspace.yaml overrides), and applesauce-react's symlinked location
	// carries its own nested node_modules/react — so without deduping, the app and
	// applesauce-react load two different React copies ("Invalid hook call"). Force
	// a single instance from the app's node_modules.
	resolve: { dedupe: ["react", "react-dom"] },
	plugins: [
		react(),
		VitePWA({
			registerType: "autoUpdate",
			manifest: {
				name: "Accordion",
				short_name: "Accordion",
				icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
			},
		}),
	],
});
