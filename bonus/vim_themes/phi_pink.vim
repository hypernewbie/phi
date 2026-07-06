" Phi Pink Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_pink"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#08080a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#f472b6 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#08080a  gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#08080a  gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#08080a  guibg=#f472b6
hi IncSearch        guifg=#08080a  guibg=#ec4899
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#f472b6 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#f472b6 guibg=#1f1f26  gui=bold
hi Directory        guifg=#ec4899

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#f472b6
hi String           guifg=#fbcfe8
hi Character        guifg=#fbcfe8
hi Number           guifg=#f472b6
hi Boolean          guifg=#f472b6
hi Float            guifg=#f472b6

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#ec4899

hi Statement        guifg=#f472b6 gui=bold
hi Conditional      guifg=#f472b6 gui=bold
hi Repeat           guifg=#f472b6 gui=bold
hi Label            guifg=#f472b6
hi Operator         guifg=#ec4899
hi Keyword          guifg=#f472b6 gui=bold
hi Exception        guifg=#b07030

hi PreProc          guifg=#be185d
hi Include          guifg=#be185d
hi Define           guifg=#be185d
hi Macro            guifg=#be185d
hi PreCondit        guifg=#be185d

hi Type             guifg=#be185d gui=bold
hi StorageClass     guifg=#be185d
hi Structure        guifg=#be185d
hi Typedef          guifg=#be185d

hi Special          guifg=#f472b6
hi SpecialChar      guifg=#fbcfe8
hi Tag              guifg=#ec4899
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#ec4899    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b07030
hi Todo             guifg=#08080a  guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#f472b6  guibg=#1f1f26  gui=bold
