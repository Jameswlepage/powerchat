import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const commonOptions = {
  bundle: true,
  sourcemap: true,
  target: ['chrome120'],
  format: 'iife',
  logLevel: 'info',
};

const configs = [
  {
    ...commonOptions,
    entryPoints: ['src/content/main.ts'],
    outfile: 'dist/content.js',
  },
  {
    ...commonOptions,
    entryPoints: ['src/background/main.ts'],
    outfile: 'dist/bg.js',
  },
];

async function build() {
  if (isWatch) {
    const contexts = await Promise.all(
      configs.map(config => esbuild.context(config))
    );
    await Promise.all(contexts.map(ctx => ctx.watch()));
    console.log('Watching for changes...');
  } else {
    await Promise.all(configs.map(config => esbuild.build(config)));
    console.log('Build complete.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
