// Regenerates src/generated from the Anchor IDL. Run after `anchor build`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rootNodeFromAnchor, type AnchorIdl } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';

const idlPath = fileURLToPath(new URL('../target/idl/gatehook.json', import.meta.url));
const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as AnchorIdl;
const codama = createFromRoot(rootNodeFromAnchor(idl));

await codama.accept(
  renderVisitor(fileURLToPath(new URL('.', import.meta.url)), {
    generatedFolder: 'src/generated',
    deleteFolderBeforeRendering: true,
    syncPackageJson: false,
  }),
);
