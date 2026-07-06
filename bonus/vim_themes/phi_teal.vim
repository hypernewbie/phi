" Phi Teal Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_teal"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#08080a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#5eead4 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#08080a  gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#08080a  gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#08080a  guibg=#5eead4
hi IncSearch        guifg=#08080a  guibg=#14b8a6
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#5eead4 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#5eead4 guibg=#1f1f26  gui=bold
hi Directory        guifg=#14b8a6

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#5eead4
hi String           guifg=#99f6e4
hi Character        guifg=#99f6e4
hi Number           guifg=#5eead4
hi Boolean          guifg=#5eead4
hi Float            guifg=#5eead4

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#14b8a6

hi Statement        guifg=#5eead4 gui=bold
hi Conditional      guifg=#5eead4 gui=bold
hi Repeat           guifg=#5eead4 gui=bold
hi Label            guifg=#5eead4
hi Operator         guifg=#14b8a6
hi Keyword          guifg=#5eead4 gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#0f766e
hi Include          guifg=#0f766e
hi Define           guifg=#0f766e
hi Macro            guifg=#0f766e
hi PreCondit        guifg=#0f766e

hi Type             guifg=#0f766e gui=bold
hi StorageClass     guifg=#0f766e
hi Structure        guifg=#0f766e
hi Typedef          guifg=#0f766e

hi Special          guifg=#5eead4
hi SpecialChar      guifg=#99f6e4
hi Tag              guifg=#14b8a6
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#14b8a6    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#08080a  guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#5eead4  guibg=#1f1f26  gui=bold
