// The reference catalogue: its keys define the message keys every other catalogue must have.
export const en = {
	'auth.name': 'Name',
	'auth.password': 'Password',
	'auth.tooManyAttempts':
		'Too many failed attempts from this address. Please wait a minute and try again.',
	'auth.passwordTooShort': 'The password needs at least {min} characters.',
	'auth.passwordTooLong': 'The password may have at most {max} characters.',

	'login.title': 'kabai studio — Sign in',
	'login.submit': 'Sign in',
	'login.wrongCredentials':
		'Wrong name or password. Forgot your password? Run “npm run reset-password” on the server.',

	'setup.title': 'Set up kabai studio',
	'setup.intro':
		'Create the owner account. The server prints the setup token on its console when it starts.',
	'setup.token': 'Setup token',
	'setup.repeatPassword': 'Repeat password',
	'setup.submit': 'Create owner',
	'setup.alreadyDone': 'Studio is already set up — please sign in at /login.',
	'setup.wrongToken':
		'Wrong setup token. The server console shows the valid one when it starts (line “Setup-Token”); after a restart a new one applies.',
	'setup.nameMissing': 'Please enter a name.',
	'setup.passwordsDiffer':
		'The two passwords do not match — please fill in both fields the same way.',

	'layout.attribution': 'by {author} · Free software, {licence}',

	'cli.usage':
		'Usage: kabai-studio [start|service <install|uninstall|status>|reset-password|restore <file>|--version]',
	'cli.unknownCommand': 'Unknown subcommand “{command}”. {usage}',
	'cli.unknownServiceCommand':
		'Unknown service subcommand “{action}”. Available: install, uninstall, status.'
};
