" Phi Violet Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_violet"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#c4b5fd gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#c4b5fd
hi IncSearch        guifg=#14141a guibg=#8b5cf6
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#c4b5fd guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#c4b5fd guibg=#1f1f26  gui=bold
hi Directory        guifg=#8b5cf6

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#c4b5fd
hi String           guifg=#ddd6fe
hi Character        guifg=#ddd6fe
hi Number           guifg=#c4b5fd
hi Boolean          guifg=#c4b5fd
hi Float            guifg=#c4b5fd

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#8b5cf6

hi Statement        guifg=#c4b5fd gui=bold
hi Conditional      guifg=#c4b5fd gui=bold
hi Repeat           guifg=#c4b5fd gui=bold
hi Label            guifg=#c4b5fd
hi Operator         guifg=#8b5cf6
hi Keyword          guifg=#c4b5fd gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#6d28d9
hi Include          guifg=#6d28d9
hi Define           guifg=#6d28d9
hi Macro            guifg=#6d28d9
hi PreCondit        guifg=#6d28d9

hi Type             guifg=#6d28d9 gui=bold
hi StorageClass     guifg=#6d28d9
hi Structure        guifg=#6d28d9
hi Typedef          guifg=#6d28d9

hi Special          guifg=#c4b5fd
hi SpecialChar      guifg=#ddd6fe
hi Tag              guifg=#8b5cf6
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#8b5cf6    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#c4b5fd  guibg=#1f1f26  gui=bold
