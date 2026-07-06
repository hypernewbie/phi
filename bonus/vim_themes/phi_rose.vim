" Phi Rose Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_rose"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#fb7185 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#fb7185
hi IncSearch        guifg=#14141a guibg=#f43f5e
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#fb7185 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#fb7185 guibg=#1f1f26  gui=bold
hi Directory        guifg=#f43f5e

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#fb7185
hi String           guifg=#fecdd3
hi Character        guifg=#fecdd3
hi Number           guifg=#fb7185
hi Boolean          guifg=#fb7185
hi Float            guifg=#fb7185

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#f43f5e

hi Statement        guifg=#fb7185 gui=bold
hi Conditional      guifg=#fb7185 gui=bold
hi Repeat           guifg=#fb7185 gui=bold
hi Label            guifg=#fb7185
hi Operator         guifg=#f43f5e
hi Keyword          guifg=#fb7185 gui=bold
hi Exception        guifg=#b07030

hi PreProc          guifg=#be123c
hi Include          guifg=#be123c
hi Define           guifg=#be123c
hi Macro            guifg=#be123c
hi PreCondit        guifg=#be123c

hi Type             guifg=#be123c gui=bold
hi StorageClass     guifg=#be123c
hi Structure        guifg=#be123c
hi Typedef          guifg=#be123c

hi Special          guifg=#fb7185
hi SpecialChar      guifg=#fecdd3
hi Tag              guifg=#f43f5e
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#f43f5e    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b07030
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#fb7185  guibg=#1f1f26  gui=bold
