" Phi Canary Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_canary"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#ffff66 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#ffff66
hi IncSearch        guifg=#14141a guibg=#ffee10
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#ffff66 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#ffff66 guibg=#1f1f26  gui=bold
hi Directory        guifg=#ffee10

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#ffff66
hi String           guifg=#ffffaa
hi Character        guifg=#ffffaa
hi Number           guifg=#ffff66
hi Boolean          guifg=#ffff66
hi Float            guifg=#ffff66

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#ffee10

hi Statement        guifg=#ffff66 gui=bold
hi Conditional      guifg=#ffff66 gui=bold
hi Repeat           guifg=#ffff66 gui=bold
hi Label            guifg=#ffff66
hi Operator         guifg=#ffee10
hi Keyword          guifg=#ffff66 gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#b8aa00
hi Include          guifg=#b8aa00
hi Define           guifg=#b8aa00
hi Macro            guifg=#b8aa00
hi PreCondit        guifg=#b8aa00

hi Type             guifg=#b8aa00 gui=bold
hi StorageClass     guifg=#b8aa00
hi Structure        guifg=#b8aa00
hi Typedef          guifg=#b8aa00

hi Special          guifg=#ffff66
hi SpecialChar      guifg=#ffffaa
hi Tag              guifg=#ffee10
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#ffee10    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#ffff66  guibg=#1f1f26  gui=bold
