import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		react(),
		VitePWA({
			registerType: "autoUpdate",
			manifest: {
				name: "Appcordion",
				short_name: "Appcordion",
				icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
			},
		}),
	],
});
