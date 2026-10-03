<script lang="ts" module>
	// Own 24 px line icons (1.6 px stroke), deliberately few — add new ones here.
	const paths = {
		x: 'M6 6l12 12M18 6 6 18',
		projects: 'M4 4.5h4.5v15H4zM9.75 4.5h4.5v9h-4.5zM15.5 4.5H20v12h-4.5z',
		inbox: 'M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5M5.5 5h13l2 8.5V19h-17v-5.5z',
		notes: 'M6 3.5h8.5l3.5 3.5v13.5H6zM14 3.5V7.5h4M9 12h6M9 15.5h4.5',
		settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4'
	} as const;
	export type IconName = keyof typeof paths;
</script>

<script lang="ts">
	let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.6"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"><path d={paths[name]} /></svg
>
