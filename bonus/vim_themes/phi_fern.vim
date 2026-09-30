" Phi Fern Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_fern"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#bccbab gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#bccbab
hi IncSearch        guifg=#14141a guibg=#9caf88
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#bccbab guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#bccbab guibg=#1f1f26  gui=bold
hi Directory        guifg=#9caf88

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#bccbab
hi String           guifg=#d8e3ca
hi Character        guifg=#d8e3ca
hi Number           guifg=#bccbab
hi Boolean          guifg=#bccbab
hi Float            guifg=#bccbab

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#9caf88

hi Statement        guifg=#bccbab gui=bold
hi Conditional      guifg=#bccbab gui=bold
hi Repeat           guifg=#bccbab gui=bold
hi Label            guifg=#bccbab
hi Operator         guifg=#9caf88
hi Keyword          guifg=#bccbab gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#6b8e5f
hi Include          guifg=#6b8e5f
hi Define           guifg=#6b8e5f
hi Macro            guifg=#6b8e5f
hi PreCondit        guifg=#6b8e5f

hi Type             guifg=#6b8e5f gui=bold
hi StorageClass     guifg=#6b8e5f
hi Structure        guifg=#6b8e5f
hi Typedef          guifg=#6b8e5f

hi Special          guifg=#bccbab
hi SpecialChar      guifg=#d8e3ca
hi Tag              guifg=#9caf88
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#9caf88    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#bccbab  guibg=#1f1f26  gui=bold
