export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace']
      },
      colors: {
        balance360: {
          bg:      '#080B10',
          surface: '#0D1117',
          card:    '#111827',
          border:  '#1C2333',
          accent:  '#00E5FF',
          dim:     '#00B8CC',
          text:    '#E2E8F0',
          muted:   '#64748B',
          danger:  '#FF4757',
          warn:    '#FFB347',
          success: '#00E676'
        }
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'scan': 'scan 2s linear infinite'
      },
      keyframes: {
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' }
        }
      }
    }
  },
  plugins: []
}
