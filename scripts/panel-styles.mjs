import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import path from 'node:path';

// Inline the compiled utilities into the shadow root, with no runtime CDN.
export function panelStyles() {
  return {
    name: 'panel-tailwind',
    resolveId(id) { if (id === 'virtual:panel-styles') return '\0panel-styles'; },
    async load(id) {
      if (id !== '\0panel-styles') return;
      const result = await postcss([tailwindcss({
        content: [path.resolve('src/ui/**/*.ts')],
        darkMode: 'class',
        theme: { extend: {} }, plugins: [],
      })]).process('@tailwind base; @tailwind components; @tailwind utilities;', { from: undefined });
      return `export default ${JSON.stringify(result.css)};`;
    },
  };
}
