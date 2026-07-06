" Phi Purple Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_purple"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#08080a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#9a8dfa gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#08080a  gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#08080a  gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#08080a  guibg=#9a8dfa
hi IncSearch        guifg=#08080a  guibg=#7c6af7
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#9a8dfa guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#9a8dfa guibg=#1f1f26  gui=bold
hi Directory        guifg=#7c6af7

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#9a8dfa
hi String           guifg=#c4b5fd
hi Character        guifg=#c4b5fd
hi Number           guifg=#9a8dfa
hi Boolean          guifg=#9a8dfa
hi Float            guifg=#9a8dfa

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#7c6af7

hi Statement        guifg=#9a8dfa gui=bold
hi Conditional      guifg=#9a8dfa gui=bold
hi Repeat           guifg=#9a8dfa gui=bold
hi Label            guifg=#9a8dfa
hi Operator         guifg=#7c6af7
hi Keyword          guifg=#9a8dfa gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#5b4ec2
hi Include          guifg=#5b4ec2
hi Define           guifg=#5b4ec2
hi Macro            guifg=#5b4ec2
hi PreCondit        guifg=#5b4ec2

hi Type             guifg=#5b4ec2 gui=bold
hi StorageClass     guifg=#5b4ec2
hi Structure        guifg=#5b4ec2
hi Typedef          guifg=#5b4ec2

hi Special          guifg=#9a8dfa
hi SpecialChar      guifg=#c4b5fd
hi Tag              guifg=#7c6af7
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#7c6af7    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#08080a  guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#9a8dfa  guibg=#1f1f26  gui=bold
