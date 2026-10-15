'use strict';

/**
 * Registrable domain lookup ("sub.mercari.com" -> "mercari.com") based on the
 * bundled Public Suffix List (psl.dat). Until the list has loaded, or if it
 * fails to load, a simple rule is used: the last two labels, or three for
 * endings like co.uk.
 */

const publicSuffixes = { rules: null, wildcards: null, exceptions: null };

// Second-level labels that form a public suffix together with a two-letter TLD (co.uk, com.au, ...).
const FALLBACK_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'ne', 'or', 'go', 'gob', 'nic', 'ltd', 'plc', 'sch']);

function toAsciiDomain(domain)
{
	if (/^[\x00-\x7f]*$/.test(domain))
	{
		return domain.toLowerCase();
	}
	try
	{
		return new URL(`http://${domain}`).hostname;
	}
	catch (err)
	{
		return domain.toLowerCase();
	}
}

async function loadPublicSuffixList()
{
	const text = await (await fetch(browser.runtime.getURL('psl.dat'))).text();
	const rules = new Set();
	const wildcards = new Set();
	const exceptions = new Set();
	for (let line of text.split('\n'))
	{
		line = line.trim();
		if (!line || line.startsWith('//'))
		{
			continue;
		}
		if (line.startsWith('!'))
		{
			exceptions.add(toAsciiDomain(line.slice(1)));
		}
		else if (line.startsWith('*.'))
		{
			wildcards.add(toAsciiDomain(line.slice(2)));
		}
		else
		{
			rules.add(toAsciiDomain(line));
		}
	}
	Object.assign(publicSuffixes, { rules, wildcards, exceptions });
}

// Public suffix plus one label. A host that is itself a public suffix is returned as is.
function registrableDomain(host)
{
	const labels = host.toLowerCase().split('.');
	let suffixLength = 1;

	if (!publicSuffixes.rules)
	{
		suffixLength = labels.length > 2 && labels.at(-1).length === 2 && FALLBACK_SECOND_LEVEL.has(labels.at(-2)) ? 2 : 1;
	}
	else
	{
		// Longest match wins; exception rules (!) cut one label off their match.
		for (let i = 0; i < labels.length; i++)
		{
			const candidate = labels.slice(i).join('.');
			if (publicSuffixes.exceptions.has(candidate))
			{
				suffixLength = labels.length - i - 1;
				break;
			}
			if (publicSuffixes.rules.has(candidate) || (i + 1 < labels.length && publicSuffixes.wildcards.has(labels.slice(i + 1).join('.'))))
			{
				suffixLength = labels.length - i;
				break;
			}
		}
	}

	return suffixLength >= labels.length ? labels.join('.') : labels.slice(-(suffixLength + 1)).join('.');
}
