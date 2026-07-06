" Phi Amber Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_amber"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#fcd34d gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a  gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a  gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a  guibg=#fcd34d
hi IncSearch        guifg=#14141a  guibg=#fbbf24
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#fcd34d guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#fcd34d guibg=#1f1f26  gui=bold
hi Directory        guifg=#fbbf24

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#fcd34d
hi String           guifg=#fde68a
hi Character        guifg=#fde68a
hi Number           guifg=#fcd34d
hi Boolean          guifg=#fcd34d
hi Float            guifg=#fcd34d

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#fbbf24

hi Statement        guifg=#fcd34d gui=bold
hi Conditional      guifg=#fcd34d gui=bold
hi Repeat           guifg=#fcd34d gui=bold
hi Label            guifg=#fcd34d
hi Operator         guifg=#fbbf24
hi Keyword          guifg=#fcd34d gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#b45309
hi Include          guifg=#b45309
hi Define           guifg=#b45309
hi Macro            guifg=#b45309
hi PreCondit        guifg=#b45309

hi Type             guifg=#b45309 gui=bold
hi StorageClass     guifg=#b45309
hi Structure        guifg=#b45309
hi Typedef          guifg=#b45309

hi Special          guifg=#fcd34d
hi SpecialChar      guifg=#fde68a
hi Tag              guifg=#fbbf24
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#fbbf24    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a  guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#fcd34d  guibg=#1f1f26  gui=bold
