<script lang="ts" module>
	// Own 24 px line icons (1.6 px stroke), deliberately few — add new ones here.
	const paths = {
		x: 'M6 6l12 12M18 6 6 18',
		projects: 'M4 4.5h4.5v15H4zM9.75 4.5h4.5v9h-4.5zM15.5 4.5H20v12h-4.5z',
		inbox: 'M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5M5.5 5h13l2 8.5V19h-17v-5.5z',
		notes: 'M6 3.5h8.5l3.5 3.5v13.5H6zM14 3.5V7.5h4M9 12h6M9 15.5h4.5',
		settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
		pause: 'M9 5.5v13M15 5.5v13',
		stop: 'M6.5 6.5h11v11h-11z',
		back: 'M19 12H5M11 6l-6 6 6 6',
		command: 'M6 8l4 4-4 4M12 16h6',
		keys: 'M3.5 6.5h17v11h-17zM7.5 10.5h.01M10.5 10.5h.01M13.5 10.5h.01M16.5 10.5h.01M8 14h8',
		// comment author kinds (Run-Akte): a head-and-shoulders mark for the human, a chip for the agent
		user: 'M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM5 20c0-4 3-6.5 7-6.5s7 2.5 7 6.5',
		agent: 'M9 9h6v6H9zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3'
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
