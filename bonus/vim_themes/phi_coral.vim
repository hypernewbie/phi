" Phi Coral Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_coral"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#f4a261 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#f4a261
hi IncSearch        guifg=#14141a guibg=#e07a5f
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#f4a261 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#f4a261 guibg=#1f1f26  gui=bold
hi Directory        guifg=#e07a5f

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#f4a261
hi String           guifg=#f8d7cc
hi Character        guifg=#f8d7cc
hi Number           guifg=#f4a261
hi Boolean          guifg=#f4a261
hi Float            guifg=#f4a261

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#e07a5f

hi Statement        guifg=#f4a261 gui=bold
hi Conditional      guifg=#f4a261 gui=bold
hi Repeat           guifg=#f4a261 gui=bold
hi Label            guifg=#f4a261
hi Operator         guifg=#e07a5f
hi Keyword          guifg=#f4a261 gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#9e4731
hi Include          guifg=#9e4731
hi Define           guifg=#9e4731
hi Macro            guifg=#9e4731
hi PreCondit        guifg=#9e4731

hi Type             guifg=#9e4731 gui=bold
hi StorageClass     guifg=#9e4731
hi Structure        guifg=#9e4731
hi Typedef          guifg=#9e4731

hi Special          guifg=#f4a261
hi SpecialChar      guifg=#f8d7cc
hi Tag              guifg=#e07a5f
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#e07a5f    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#f4a261  guibg=#1f1f26  gui=bold
