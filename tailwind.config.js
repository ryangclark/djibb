import tailwind_typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/**/*.{html,js,svelte,ts}'],
	theme: {
		extend: {},
	},
	// https://tailwindcss.com/docs/typography-plugin
	plugins: [tailwind_typography()],
};
