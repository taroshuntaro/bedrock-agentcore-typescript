import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // cdk.out には Docker ビルドコンテキスト（リポジトリ全体）がステージングされ、
    // テストファイルが複製されるため除外する（node_modules / dist は既定で除外）。
    exclude: [...configDefaults.exclude, '**/cdk.out/**'],
  },
})
