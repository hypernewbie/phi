" Phi Green Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_green"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#08080a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#34d399 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#08080a  gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#08080a  gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#08080a  guibg=#34d399
hi IncSearch        guifg=#08080a  guibg=#10b981
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#34d399 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#34d399 guibg=#1f1f26  gui=bold
hi Directory        guifg=#10b981

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#34d399
hi String           guifg=#a7f3d0
hi Character        guifg=#a7f3d0
hi Number           guifg=#34d399
hi Boolean          guifg=#34d399
hi Float            guifg=#34d399

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#10b981

hi Statement        guifg=#34d399 gui=bold
hi Conditional      guifg=#34d399 gui=bold
hi Repeat           guifg=#34d399 gui=bold
hi Label            guifg=#34d399
hi Operator         guifg=#10b981
hi Keyword          guifg=#34d399 gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#047857
hi Include          guifg=#047857
hi Define           guifg=#047857
hi Macro            guifg=#047857
hi PreCondit        guifg=#047857

hi Type             guifg=#047857 gui=bold
hi StorageClass     guifg=#047857
hi Structure        guifg=#047857
hi Typedef          guifg=#047857

hi Special          guifg=#34d399
hi SpecialChar      guifg=#a7f3d0
hi Tag              guifg=#10b981
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#10b981    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#08080a  guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#34d399  guibg=#1f1f26  gui=bold
