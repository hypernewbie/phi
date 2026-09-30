" Phi Ash Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_ash"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#d6d3d1 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#d6d3d1
hi IncSearch        guifg=#14141a guibg=#a8a29e
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#d6d3d1 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#d6d3d1 guibg=#1f1f26  gui=bold
hi Directory        guifg=#a8a29e

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#d6d3d1
hi String           guifg=#e7e5e4
hi Character        guifg=#e7e5e4
hi Number           guifg=#d6d3d1
hi Boolean          guifg=#d6d3d1
hi Float            guifg=#d6d3d1

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#a8a29e

hi Statement        guifg=#d6d3d1 gui=bold
hi Conditional      guifg=#d6d3d1 gui=bold
hi Repeat           guifg=#d6d3d1 gui=bold
hi Label            guifg=#d6d3d1
hi Operator         guifg=#a8a29e
hi Keyword          guifg=#d6d3d1 gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#78716c
hi Include          guifg=#78716c
hi Define           guifg=#78716c
hi Macro            guifg=#78716c
hi PreCondit        guifg=#78716c

hi Type             guifg=#78716c gui=bold
hi StorageClass     guifg=#78716c
hi Structure        guifg=#78716c
hi Typedef          guifg=#78716c

hi Special          guifg=#d6d3d1
hi SpecialChar      guifg=#e7e5e4
hi Tag              guifg=#a8a29e
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#a8a29e    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#d6d3d1  guibg=#1f1f26  gui=bold
