// Settings for web-ext (https://extensionworkshop.com/documentation/develop/web-ext-command-reference/).
// Repository files that are not part of the add-on stay out of the .xpi.
export default {
	ignoreFiles: [
		'web-ext-config.mjs',
		'README.md',
		'CHANGELOG.md',
		'CLAUDE.md',
	],
	build: {
		overwriteDest: true,
	},
};
