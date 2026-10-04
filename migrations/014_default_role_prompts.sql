-- Role prompts that still hold the previous default text byte for byte get the current default, which says what to
-- do, what to deliver and when to stop. Edited role prompts stay as they are.

UPDATE columns SET role_prompt =
	'Do: sort new work in. Give the ticket a clear title and a short description of the need, and add only what is obviously missing. Do not refine it: scope and acceptance criteria come in Refine. Deliver: a ticket someone else can understand, and a short comment on what you added. Stop: move it on to Refine, or leave it here when it should wait.'
WHERE role_prompt =
	'Capture new work with enough detail that someone else could size it. Move it along once it is ready for scope and acceptance criteria to be worked out.';

UPDATE columns SET role_prompt =
	'Do: propose the scope yourself from what the ticket says: what is in and out, a rough effort and observable acceptance criteria. Fill gaps with sensible defaults and name them as assumptions. Ask the human only for a genuine product decision you cannot default, never as your first step. Deliver: an updated description and one task per acceptance criterion. Stop: move the ticket on to Ready.'
WHERE role_prompt =
	'Make the scope, the effort and the acceptance criteria explicit before moving a ticket on. Leave a title-only ticket for someone else to flesh out instead of advancing it as is.';

UPDATE columns SET role_prompt =
	'Do: pick the ticket up; do not refine it. Check that no blocker is still open. Deliver: a pickup comment with your plan in one or two sentences. Stop: move the ticket to In Arbeit right away. Only if the description no longer matches reality, send it back to Refine with a comment saying why.'
WHERE role_prompt =
	'Pick up a ticket only once every blocker is finished. If the description no longer matches reality, send it back for refinement with a comment explaining why.';

UPDATE columns SET role_prompt =
	'Do: carry out the task the ticket describes and write what it asks for as text: an answer, an analysis or code. Do not refine: leave the description and the tasks as they are. Deliver: the result itself in a comment, code in a fenced block, marked "Unverified: not compiled, run or tested."; then tick each task the result fulfils. Ask the human only if the task needs more than text, such as changing files in a repository. Stop: move the ticket to Review once the result is delivered.'
WHERE role_prompt =
	'For a bug, reproduce it with a failing test before you fix it. A probe someone used to demonstrate a finding becomes a permanent regression test. Move the ticket on once every acceptance criterion is met.';

UPDATE columns SET role_prompt =
	'Do: check the delivered result against the acceptance criteria, not against your own taste. Deliver: a comment with one finding per unmet criterion, or a short "Review ok". Stop: with findings, send the ticket back to In Arbeit; without, approve it and move it on to Abnahme.'
WHERE role_prompt =
	'Check the work against its acceptance criteria, not your own taste. Leave findings as a comment and send it back, or approve it and move it on.';

UPDATE columns SET role_prompt =
	'Do: nothing; finished work waits here for a human to accept it in a batch. Deliver: nothing, neither a comment nor a change. Stop: right away, without moving the ticket.'
WHERE role_prompt =
	'Finished work waits here for a human to accept it in a batch. Do not act on a ticket sitting in this column.';

UPDATE columns SET role_prompt =
	'Do: wait; a question to the human is open and blocks this ticket. Deliver: nothing; do not resume the work or ask again. Stop: right away, without moving the ticket; the answer brings it back into work.'
WHERE role_prompt =
	'A question is open and blocks this ticket. Read it in the comments and wait for an answer instead of resuming work.';

UPDATE columns SET role_prompt =
	'Do: read the answer to the open question in the comments and act on it. Deliver: a short comment on how the answer changes the work. Stop: move the ticket back to the column where the work continues.'
WHERE role_prompt =
	'An open question now has an answer. Read it in the comments, then move the ticket back into work.';
