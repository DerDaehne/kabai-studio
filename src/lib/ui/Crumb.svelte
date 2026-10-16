<script lang="ts">
	import { placeBelow } from '$lib/shell/trail';
	import Icon from './Icon.svelte';

	/** The way up to the parent place: back when the parent is the place below in history, else forward to it. */
	let { href, label }: { href: string; label: string } = $props();

	function goUp(event: MouseEvent) {
		const plain =
			event.button === 0 && !(event.ctrlKey || event.metaKey || event.shiftKey || event.altKey);
		if (!plain || placeBelow() !== href) return;
		event.preventDefault();
		history.back();
	}
</script>

<a class="rk-crumb" {href} onclick={goUp}><Icon name="back" size={16} />{label}</a>
