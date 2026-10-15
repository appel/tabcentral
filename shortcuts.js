'use strict';

/**
 * Shortcuts section of the page: lists the extension's commands with a field that
 * records a new key combination, a button to remove it, and "Restore
 * defaults". Changes go through browser.commands, so they are the same
 * shortcuts as in Firefox's "Manage Extension Shortcuts".
 *
 * Firefox's rules for a shortcut: Ctrl or Alt (Command counts as Ctrl on a
 * Mac), optionally one more modifier (Shift, or the other of Ctrl/Alt), plus
 * a letter, digit, F1-F12 or a navigation key. F1-F12 may also be used alone.
 */

const SHORTCUT_KEYS = {
	Comma: 'Comma', Period: 'Period', Space: 'Space', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
	Insert: 'Insert', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

// Key name in Firefox's shortcut syntax, from the physical key (so Shift+1 is still "1"), or null.
function shortcutKey(e)
{
	if (/^Key[A-Z]$/.test(e.code))
	{
		return e.code.slice(3);
	}
	if (/^Digit[0-9]$/.test(e.code))
	{
		return e.code.slice(5);
	}
	if (/^F([1-9]|1[0-2])$/.test(e.code))
	{
		return e.code;
	}
	return SHORTCUT_KEYS[e.code] || null;
}

// Returns { shortcut } or { error } for a key press, or null while only modifiers are held.
function shortcutFromEvent(e)
{
	const key = shortcutKey(e);
	if (!key)
	{
		return ['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(e.key) ? null : { error: 'That key cannot be used in a shortcut.' };
	}
	const modifiers = [];
	if (e.ctrlKey || e.metaKey)
	{
		modifiers.push('Ctrl');
	}
	if (e.altKey)
	{
		modifiers.push('Alt');
	}
	if (e.shiftKey)
	{
		modifiers.push('Shift');
	}
	const functionKey = /^F\d+$/.test(key);
	if (!functionKey && !modifiers.some(modifier => modifier === 'Ctrl' || modifier === 'Alt'))
	{
		return { error: 'Use Ctrl or Alt (optionally with Shift) together with the key.' };
	}
	if (modifiers.length > 2)
	{
		return { error: 'Use at most two modifier keys.' };
	}
	return { shortcut: [...modifiers, key].join('+') };
}

async function renderShortcuts()
{
	const commands = await browser.commands.getAll();
	// The popup first, then the commands in manifest order.
	commands.sort((a, b) => (b.name === '_execute_action') - (a.name === '_execute_action'));
	$('#shortcut-list').replaceChildren(...commands.map(command => el('div', { class: 'setting shortcut-row' },
		el('span', { text: command.description || command.name }),
		el('span', { class: 'shortcut-controls' },
			el('button', {
				class: 'nova-button shortcut-field' + (command.shortcut ? '' : ' empty'),
				type: 'button',
				'aria-label': `${command.description}: ${command.shortcut || 'no shortcut'}. Press to record a new shortcut.`,
				text: command.shortcut || 'Not set',
				onclick: e => recordShortcut(e.currentTarget, command),
			}),
			el('button', {
				class: 'nova-icon-button',
				type: 'button',
				icon: 'close',
				title: 'Remove shortcut',
				'aria-label': `Remove shortcut: ${command.description}`,
				disabled: !command.shortcut,
				onclick: () => setShortcut(command, ''),
			}),
		),
	)));
}

function recordShortcut(button, command)
{
	button.classList.add('recording');
	button.textContent = 'Press keys…';
	const stop = () =>
	{
		button.removeEventListener('keydown', onKey);
		button.removeEventListener('blur', onBlur);
	};
	const onBlur = () =>
	{
		stop();
		renderShortcuts().catch(showError);
	};
	const onKey = e =>
	{
		e.preventDefault();
		e.stopPropagation();
		if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey)
		{
			onBlur();
			return;
		}
		const result = shortcutFromEvent(e);
		if (!result)
		{
			return;
		}
		if (result.error)
		{
			showToast(result.error, true);
			return;
		}
		stop();
		setShortcut(command, result.shortcut);
	};
	button.addEventListener('keydown', onKey);
	button.addEventListener('blur', onBlur);
}

async function setShortcut(command, shortcut)
{
	try
	{
		await browser.commands.update({ name: command.name, shortcut });
		showToast(shortcut ? `${command.description}: ${shortcut}` : `Shortcut removed: ${command.description}`);
	}
	catch (err)
	{
		showError(err);
	}
	await renderShortcuts();
}

function bindShortcuts()
{
	$('#shortcuts-reset').addEventListener('click', async () =>
	{
		for (const command of await browser.commands.getAll())
		{
			await browser.commands.reset(command.name);
		}
		showToast('Shortcuts restored to their defaults');
		await renderShortcuts();
	});
}
