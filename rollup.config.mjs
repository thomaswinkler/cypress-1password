import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import dts from 'rollup-plugin-dts';
import fs from 'fs';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

export default [
  {
    input: 'dist/index.js',
    output: [
      {
        file: 'dist/index.js',
        format: "commonjs",
        sourcemap: true,
      },
    ],
    plugins: [
      resolve(),
      commonjs(),
      json()
    ],
    external: (id) => {
      return Object.keys(pkg.dependencies || {}).some(dep => id === dep || id.startsWith(`${dep}/`)) ||
        Object.keys(pkg.peerDependencies || {}).some(dep => id === dep || id.startsWith(`${dep}/`));
    },
  },
  {
    input: 'dist/index.d.ts',
    output: [{ file: 'dist/index.d.ts', format: 'es', sourcemap: false }],
    plugins: [dts()],
  }
];
