/**
 * The SDK must load the Baileys fork it ships with.
 *
 * This SDK runs inside `@souzzaaxzy/baileys` (published as `@itsliaaa/baileys`).
 * Earlier it also tried the upstream `@itsliaaa/baileys` as a fallback —
 * the wrong library for this project. The loaders now try only the fork names.
 *
 * This test pins the behaviour: the loader tries the fork names (and not the
 * upstream one), and reports what it actually tried when neither is present.
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
    it('tries the fork names and NOT the upstream package', () => {
        for (const file of ['signaling.mjs', 'index.mjs', 'group-media.mjs']) {
            const src = fs.readFileSync(path.join(ROOT, 'dist', file), 'utf-8');
            assert.match(src, /@itsliaaa\/baileys/, `${file} tenta o nome publicado da fork`);
            assert.doesNotMatch(
                src,
                /@whiskeysockets\/baileys/,
                `${file} NAO pode tentar o upstream (fork antiga)`
            );
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
