import mermaid from 'mermaid';

// The extension host injects the rendered Markdown (with <pre class="mermaid">
// blocks) directly into the page, so render those diagrams once on load.
mermaid.initialize({ startOnLoad: false });
void mermaid.run();
