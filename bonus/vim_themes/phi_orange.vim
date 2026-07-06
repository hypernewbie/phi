" Phi Orange Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_orange"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#08080a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#fdba74 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#08080a  gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#08080a  gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#08080a  guibg=#fdba74
hi IncSearch        guifg=#08080a  guibg=#f97316
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#fdba74 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#fdba74 guibg=#1f1f26  gui=bold
hi Directory        guifg=#f97316

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#fdba74
hi String           guifg=#fed7aa
hi Character        guifg=#fed7aa
hi Number           guifg=#fdba74
hi Boolean          guifg=#fdba74
hi Float            guifg=#fdba74

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#f97316

hi Statement        guifg=#fdba74 gui=bold
hi Conditional      guifg=#fdba74 gui=bold
hi Repeat           guifg=#fdba74 gui=bold
hi Label            guifg=#fdba74
hi Operator         guifg=#f97316
hi Keyword          guifg=#fdba74 gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#c2410c
hi Include          guifg=#c2410c
hi Define           guifg=#c2410c
hi Macro            guifg=#c2410c
hi PreCondit        guifg=#c2410c

hi Type             guifg=#c2410c gui=bold
hi StorageClass     guifg=#c2410c
hi Structure        guifg=#c2410c
hi Typedef          guifg=#c2410c

hi Special          guifg=#fdba74
hi SpecialChar      guifg=#fed7aa
hi Tag              guifg=#f97316
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#f97316    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#08080a  guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#fdba74  guibg=#1f1f26  gui=bold
