" Phi Dusk Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_dusk"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#d4cae0 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#d4cae0
hi IncSearch        guifg=#14141a guibg=#b8a9c9
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#d4cae0 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#d4cae0 guibg=#1f1f26  gui=bold
hi Directory        guifg=#b8a9c9

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#d4cae0
hi String           guifg=#ebe5f0
hi Character        guifg=#ebe5f0
hi Number           guifg=#d4cae0
hi Boolean          guifg=#d4cae0
hi Float            guifg=#d4cae0

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#b8a9c9

hi Statement        guifg=#d4cae0 gui=bold
hi Conditional      guifg=#d4cae0 gui=bold
hi Repeat           guifg=#d4cae0 gui=bold
hi Label            guifg=#d4cae0
hi Operator         guifg=#b8a9c9
hi Keyword          guifg=#d4cae0 gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#7c6f8a
hi Include          guifg=#7c6f8a
hi Define           guifg=#7c6f8a
hi Macro            guifg=#7c6f8a
hi PreCondit        guifg=#7c6f8a

hi Type             guifg=#7c6f8a gui=bold
hi StorageClass     guifg=#7c6f8a
hi Structure        guifg=#7c6f8a
hi Typedef          guifg=#7c6f8a

hi Special          guifg=#d4cae0
hi SpecialChar      guifg=#ebe5f0
hi Tag              guifg=#b8a9c9
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#b8a9c9    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#d4cae0  guibg=#1f1f26  gui=bold
