/**
 * The SDK must load whichever Baileys distribution is installed.
 *
 * The upstream package hard-coded `@whiskeysockets/baileys`, so in a project
 * that uses a fork (`@itsliaaa/baileys`, as this bot does) every call failed with
 * "Could not import @whiskeysockets/baileys. Install it as a peer dependency."
 *
 * This test pins the behaviour: the loader tries both names and reports what it
 * actually tried when neither is present.
 *
 * Run: node --test tests/baileys-loader.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

describe('Baileys loader', () => {
    it('tries the fork name as well as upstream', () => {
        for (const file of ['signaling.mjs', 'index.mjs']) {
            const src = fs.readFileSync(path.join(ROOT, 'dist', file), 'utf-8');
            assert.match(src, /@itsliaaa\/baileys/, `${file} tenta o nome da fork`);
            assert.match(src, /@whiskeysockets\/baileys/, `${file} tenta o upstream`);
            // The old shape threw on the first failure; the new one must not.
            assert.doesNotMatch(
                src,
                /Could not import @whiskeysockets\/baileys\. Install it as a peer dependency\./,
                `${file} nao pode manter a mensagem fixa do upstream`
            );
        }
    });

    it('the error message lists every package it tried', () => {
        const src = fs.readFileSync(path.join(ROOT, 'dist', 'signaling.mjs'), 'utf-8');
        assert.match(src, /Tried:/, 'diz o que tentou');
    });
});
