" Phi Pine Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_pine"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#a8c2bc gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#a8c2bc
hi IncSearch        guifg=#14141a guibg=#84a59d
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#a8c2bc guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#a8c2bc guibg=#1f1f26  gui=bold
hi Directory        guifg=#84a59d

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#a8c2bc
hi String           guifg=#c8dad5
hi Character        guifg=#c8dad5
hi Number           guifg=#a8c2bc
hi Boolean          guifg=#a8c2bc
hi Float            guifg=#a8c2bc

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#84a59d

hi Statement        guifg=#a8c2bc gui=bold
hi Conditional      guifg=#a8c2bc gui=bold
hi Repeat           guifg=#a8c2bc gui=bold
hi Label            guifg=#a8c2bc
hi Operator         guifg=#84a59d
hi Keyword          guifg=#a8c2bc gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#5b7065
hi Include          guifg=#5b7065
hi Define           guifg=#5b7065
hi Macro            guifg=#5b7065
hi PreCondit        guifg=#5b7065

hi Type             guifg=#5b7065 gui=bold
hi StorageClass     guifg=#5b7065
hi Structure        guifg=#5b7065
hi Typedef          guifg=#5b7065

hi Special          guifg=#a8c2bc
hi SpecialChar      guifg=#c8dad5
hi Tag              guifg=#84a59d
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#84a59d    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#a8c2bc  guibg=#1f1f26  gui=bold
