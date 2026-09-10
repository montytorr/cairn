import next from 'eslint-config-next'

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'cli/dist/**'] },
  ...next,
]

export default config
