" Phi Arc Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_arc"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#66e0ff gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#66e0ff
hi IncSearch        guifg=#14141a guibg=#00d4ff
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#66e0ff guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#66e0ff guibg=#1f1f26  gui=bold
hi Directory        guifg=#00d4ff

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#66e0ff
hi String           guifg=#99ebff
hi Character        guifg=#99ebff
hi Number           guifg=#66e0ff
hi Boolean          guifg=#66e0ff
hi Float            guifg=#66e0ff

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#00d4ff

hi Statement        guifg=#66e0ff gui=bold
hi Conditional      guifg=#66e0ff gui=bold
hi Repeat           guifg=#66e0ff gui=bold
hi Label            guifg=#66e0ff
hi Operator         guifg=#00d4ff
hi Keyword          guifg=#66e0ff gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#0080c0
hi Include          guifg=#0080c0
hi Define           guifg=#0080c0
hi Macro            guifg=#0080c0
hi PreCondit        guifg=#0080c0

hi Type             guifg=#0080c0 gui=bold
hi StorageClass     guifg=#0080c0
hi Structure        guifg=#0080c0
hi Typedef          guifg=#0080c0

hi Special          guifg=#66e0ff
hi SpecialChar      guifg=#99ebff
hi Tag              guifg=#00d4ff
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#00d4ff    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#66e0ff  guibg=#1f1f26  gui=bold
