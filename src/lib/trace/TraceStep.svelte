<script lang="ts">
	import {
		firstLine,
		formatCount,
		reasonText,
		resultText,
		stepGist,
		type TraceCall,
		type TraceStep
	} from './trace';

	/** `compact`: only the line of the step's current call, as the Stellwerk shows a run's „now“. */
	let { step, compact = false }: { step: TraceStep; compact?: boolean } = $props();

	const current = $derived(step.calls.at(-1));
	const json = (value: unknown) => JSON.stringify(value ?? {}, null, 2);
</script>

{#snippet callLine(call: TraceCall)}
	<span class="tool mono">{call.tool}</span>
	{#if call.target}· <span class="target mono">{call.target}</span>{/if}
	· <span class="reason" class:empty={!call.reason}>{reasonText(call)}</span>
{/snippet}

{#if compact}
	<p class="line">
		{#if current}{@render callLine(current)}{:else}{stepGist(step)}{/if}
	</p>
{:else}
	<article class="step">
		<h4>Schritt {step.number}</h4>
		{#if step.reasoning}
			{@const { text, charsTotal } = step.reasoning}
			<details class="reasoning">
				<summary>
					denkt: {firstLine(text)}
					<span class="muted">({formatCount(charsTotal)} Zeichen)</span>
				</summary>
				{#if charsTotal > text.length}
					<p class="muted">
						Gekürzt: gespeichert sind die letzten {formatCount(text.length)} Zeichen.
					</p>
				{/if}
				<pre class="mono">{text}</pre>
			</details>
		{/if}
		{#if step.message}<p class="message">{step.message}</p>{/if}
		{#if step.calls.length}
			<ul class="calls">
				{#each step.calls as call (call.id)}
					{@const summary = resultText(call.result)}
					{@const failed = call.result?.isError}
					<li>
						<details class="call">
							<summary class="line">
								{@render callLine(call)}
								{#if summary}
									· <span class="result" class:error={failed}>
										{#if failed}<span aria-hidden="true">✗</span>{/if}
										{summary}
									</span>
								{/if}
							</summary>
							<p class="label">Argumente</p>
							<pre class="mono">{json(call.args)}</pre>
							<p class="label">Ergebnis</p>
							{#if call.result}
								<pre class="mono">{call.result.text}</pre>
							{:else}
								<p class="muted">Noch kein Ergebnis.</p>
							{/if}
						</details>
					</li>
				{/each}
			</ul>
		{/if}
	</article>
{/if}

<style>
	.step {
		display: grid;
		gap: var(--space-1);
	}
	h4 {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-sm);
		font-weight: 560;
	}
	.line,
	.message {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.calls {
		display: grid;
		gap: var(--space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	summary {
		cursor: pointer;
		border-radius: var(--radius-sm);
	}
	.tool {
		font-weight: 560;
	}
	.reason.empty,
	.muted {
		color: var(--text-muted);
	}
	.result.error {
		color: var(--status-failed);
	}
	.label {
		margin: var(--space-2) 0 0;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	pre {
		margin: var(--space-1) 0 0;
		padding: var(--space-2);
		border-radius: var(--radius-sm);
		background: var(--surface);
		font-size: var(--text-sm);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
