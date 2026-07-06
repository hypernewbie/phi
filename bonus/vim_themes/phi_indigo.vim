" Phi Indigo Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_indigo"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#818cf8 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a  gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a  gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a  guibg=#818cf8
hi IncSearch        guifg=#14141a  guibg=#6366f1
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#818cf8 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#818cf8 guibg=#1f1f26  gui=bold
hi Directory        guifg=#6366f1

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#818cf8
hi String           guifg=#a5b4fc
hi Character        guifg=#a5b4fc
hi Number           guifg=#818cf8
hi Boolean          guifg=#818cf8
hi Float            guifg=#818cf8

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#6366f1

hi Statement        guifg=#818cf8 gui=bold
hi Conditional      guifg=#818cf8 gui=bold
hi Repeat           guifg=#818cf8 gui=bold
hi Label            guifg=#818cf8
hi Operator         guifg=#6366f1
hi Keyword          guifg=#818cf8 gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#4338ca
hi Include          guifg=#4338ca
hi Define           guifg=#4338ca
hi Macro            guifg=#4338ca
hi PreCondit        guifg=#4338ca

hi Type             guifg=#4338ca gui=bold
hi StorageClass     guifg=#4338ca
hi Structure        guifg=#4338ca
hi Typedef          guifg=#4338ca

hi Special          guifg=#818cf8
hi SpecialChar      guifg=#a5b4fc
hi Tag              guifg=#6366f1
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#6366f1    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a  guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#818cf8  guibg=#1f1f26  gui=bold
