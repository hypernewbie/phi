" Phi Neon Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_neon"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#70f8ff gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#70f8ff
hi IncSearch        guifg=#14141a guibg=#00f0ff
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#70f8ff guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#70f8ff guibg=#1f1f26  gui=bold
hi Directory        guifg=#00f0ff

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#70f8ff
hi String           guifg=#b3fcff
hi Character        guifg=#b3fcff
hi Number           guifg=#70f8ff
hi Boolean          guifg=#70f8ff
hi Float            guifg=#70f8ff

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#00f0ff

hi Statement        guifg=#70f8ff gui=bold
hi Conditional      guifg=#70f8ff gui=bold
hi Repeat           guifg=#70f8ff gui=bold
hi Label            guifg=#70f8ff
hi Operator         guifg=#00f0ff
hi Keyword          guifg=#70f8ff gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#008b99
hi Include          guifg=#008b99
hi Define           guifg=#008b99
hi Macro            guifg=#008b99
hi PreCondit        guifg=#008b99

hi Type             guifg=#008b99 gui=bold
hi StorageClass     guifg=#008b99
hi Structure        guifg=#008b99
hi Typedef          guifg=#008b99

hi Special          guifg=#70f8ff
hi SpecialChar      guifg=#b3fcff
hi Tag              guifg=#00f0ff
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#00f0ff    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#70f8ff  guibg=#1f1f26  gui=bold
