" Phi Red Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_red"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#08080a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#fca5a5 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#08080a  gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#08080a  gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#08080a  guibg=#fca5a5
hi IncSearch        guifg=#08080a  guibg=#f87171
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#fca5a5 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#fca5a5 guibg=#1f1f26  gui=bold
hi Directory        guifg=#f87171

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#fca5a5
hi String           guifg=#fecaca
hi Character        guifg=#fecaca
hi Number           guifg=#fca5a5
hi Boolean          guifg=#fca5a5
hi Float            guifg=#fca5a5

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#f87171

hi Statement        guifg=#fca5a5 gui=bold
hi Conditional      guifg=#fca5a5 gui=bold
hi Repeat           guifg=#fca5a5 gui=bold
hi Label            guifg=#fca5a5
hi Operator         guifg=#f87171
hi Keyword          guifg=#fca5a5 gui=bold
hi Exception        guifg=#b07030

hi PreProc          guifg=#b91c1c
hi Include          guifg=#b91c1c
hi Define           guifg=#b91c1c
hi Macro            guifg=#b91c1c
hi PreCondit        guifg=#b91c1c

hi Type             guifg=#b91c1c gui=bold
hi StorageClass     guifg=#b91c1c
hi Structure        guifg=#b91c1c
hi Typedef          guifg=#b91c1c

hi Special          guifg=#fca5a5
hi SpecialChar      guifg=#fecaca
hi Tag              guifg=#f87171
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#f87171    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b07030
hi Todo             guifg=#08080a  guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#fca5a5  guibg=#1f1f26  gui=bold
