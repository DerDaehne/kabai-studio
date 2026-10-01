<!-- Background light behind glass: two soft patches drifting slowly; static under reduced motion (base.css) -->
<div class="nebula" aria-hidden="true"><i></i><i></i></div>

<style>
	.nebula {
		position: absolute;
		inset: 0;
		z-index: -1;
		overflow: hidden;
		pointer-events: none;
	}
	i {
		position: absolute;
		width: 70%;
		height: 70%;
		border-radius: 50%;
		filter: blur(60px);
	}
	i:first-child {
		top: -25%;
		left: -15%;
		background: var(--nebula-1);
		animation: drift 38s var(--ease-inout) infinite alternate;
	}
	i:last-child {
		top: 10%;
		right: -20%;
		background: var(--nebula-2);
		animation: drift 46s var(--ease-inout) infinite alternate-reverse;
	}
	@keyframes drift {
		to {
			transform: translate(8%, 6%) scale(1.1);
		}
	}
</style>
