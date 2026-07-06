" Phi White Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_white"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#ffffff gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#ffffff
hi IncSearch        guifg=#14141a guibg=#ffffff
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#ffffff guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#ffffff guibg=#1f1f26  gui=bold
hi Directory        guifg=#ffffff

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#ffffff
hi String           guifg=#e2e8f0
hi Character        guifg=#e2e8f0
hi Number           guifg=#ffffff
hi Boolean          guifg=#ffffff
hi Float            guifg=#ffffff

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#ffffff

hi Statement        guifg=#ffffff gui=bold
hi Conditional      guifg=#ffffff gui=bold
hi Repeat           guifg=#ffffff gui=bold
hi Label            guifg=#ffffff
hi Operator         guifg=#ffffff
hi Keyword          guifg=#ffffff gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#94a3b8
hi Include          guifg=#94a3b8
hi Define           guifg=#94a3b8
hi Macro            guifg=#94a3b8
hi PreCondit        guifg=#94a3b8

hi Type             guifg=#94a3b8 gui=bold
hi StorageClass     guifg=#94a3b8
hi Structure        guifg=#94a3b8
hi Typedef          guifg=#94a3b8

hi Special          guifg=#ffffff
hi SpecialChar      guifg=#e2e8f0
hi Tag              guifg=#ffffff
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#ffffff    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#ffffff  guibg=#1f1f26  gui=bold
