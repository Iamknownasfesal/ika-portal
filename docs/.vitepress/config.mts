import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Ika Portal',
  description: 'Give every Solana account native Bitcoin, Ethereum and Base addresses, controlled by Solana, with on-chain policies.',
  cleanUrls: true,
  lastUpdated: true,
  // docs/README.md doubles as the GitHub index; on the site it is the Overview page.
  rewrites: { 'README.md': 'overview.md' },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' }],
    ['link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }],
    ['meta', { name: 'theme-color', content: '#0b0a1f' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Ika Portal' }],
    ['meta', { property: 'og:description', content: 'Native Bitcoin, Ethereum & Base for every Solana account, with on-chain policies. Powered by Ika dWallets.' }],
    ['meta', { property: 'og:image', content: 'https://ika-portal-docs.vercel.app/og.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://ika-portal-docs.vercel.app/og.png' }],
  ],
  markdown: { lineNumbers: false, theme: { light: 'github-light', dark: 'github-dark' } },
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Ika Portal',
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/Iamknownasfesal/ika-portal' }],
    editLink: { pattern: 'https://github.com/Iamknownasfesal/ika-portal/edit/main/docs/:path', text: 'Edit this page on GitHub' },
    outline: { level: [2, 3], label: 'On this page' },
    nav: [
      { text: 'Get started', link: '/getting-started' },
      { text: 'Guides', link: '/guides/accounts' },
      { text: 'Reference', link: '/reference/api' },
      { text: 'Devnet', link: '/overview#devnet-endpoints' },
      { text: 'Demo wallet', link: 'https://ika-portal-wallet.vercel.app' },
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Overview', link: '/overview' },
          { text: 'Getting started', link: '/getting-started' },
          { text: 'Concepts', link: '/concepts' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Creating accounts', link: '/guides/accounts' },
          { text: 'Sending', link: '/guides/sending' },
          { text: 'Policies', link: '/guides/policies' },
          { text: 'Swaps', link: '/guides/swaps' },
          { text: 'Gasless EVM (EIP-7702)', link: '/guides/evm-gasless' },
          { text: 'Recovery', link: '/guides/recovery' },
          { text: 'Squads & PDA owners', link: '/guides/pda-owners' },
          { text: 'Browser integration', link: '/guides/browser' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'API', link: '/reference/api' },
          { text: 'Error codes', link: '/reference/errors' },
          { text: 'Program', link: '/reference/program' },
        ],
      },
      {
        text: 'Operate',
        items: [
          { text: 'Operations', link: '/operations' },
          { text: 'Security & trust model', link: '/security' },
          { text: 'FAQ & troubleshooting', link: '/faq' },
        ],
      },
    ],
    docFooter: { prev: 'Previous', next: 'Next' },
    footer: { message: 'Testnet / devnet only. The Ika Solana pre-alpha uses a mock signer.', copyright: 'Ika Portal SDK' },
  },
});
