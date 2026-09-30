'use strict';
/**
 * قواعد بسيطة ومقصودة: تمسك الأخطاء الحقيقية (متغير غير معرّف، await منسي،
 * متغير ميت) دون فرض أسلوب تنسيق يقاومه كود المشروع المكتوب بالعربية.
 */
module.exports = [
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
        console: 'readonly', __dirname: 'readonly', __filename: 'readonly',
        Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly', URL: 'readonly',
        fetch: 'readonly', structuredClone: 'readonly', AbortController: 'readonly',
      },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-cond-assign': ['error', 'except-parens'],
      eqeqeq: ['warn', 'smart'],
      'require-atomic-updates': 'off',
      'no-return-await': 'warn',
      'no-throw-literal': 'error',
      'no-self-compare': 'error',
      'valid-typeof': 'error',
    },
  },
  {
    // ملفات الاختبار تستخدم node:test وassert بشكل حر
    files: ['tests/**/*.js'],
    rules: { 'no-unused-vars': 'off' },
  },
];
